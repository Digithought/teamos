import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { PRIORITY_ORDER } from '../scheduler.mjs';

/**
 * File-backed commit-triggers adapter.
 *
 * Subscriptions at team/members/<name>/triggers.json:
 *   { "items": [ CommitTrigger, ... ] }
 *
 * Scan state at team/.logs/triggers/<name>.json:
 *   {
 *     "cursor": "<SHA scanned through — NOT the same as "seen by the member">",
 *     "matches": [ CommitMatch, ... ]  // durable until explicitly cleared
 *   }
 *
 * Triggers subscribe the member to git commits in the host repo. On each call
 * to `pendingMatches`, the adapter scans <cursor>..HEAD for commits matching
 * any trigger's filters and appends newly discovered ones to the match
 * ledger, then advances `cursor` past them. The cursor's only job is "which
 * commits have been checked against the filters" — advancing it costs
 * nothing, because a match, once found, is durably recorded before the
 * cursor moves past its commit.
 *
 * The two halves are split because they change at completely different
 * rates and need different durability. Subscriptions are hand-reviewable and
 * change when a member decides to watch something; the cursor advances on
 * essentially every scan (including ones that happen during work-detection,
 * well before any cycle runs). `team/` is git-synced, so keeping the cursor
 * there would mean a commit every scan. `team/.logs/` is already the
 * directory teamos gitignores for exactly this kind of runner-managed churn.
 *
 * A match is delivered — shown in a cycle prompt — every time it is still in
 * the ledger, not just the one time it first appears. It stays in the ledger
 * until a `clear_trigger_matches` call explicitly removes it, the same
 * "must be actively cleared" contract inbox messages already have. This is
 * deliberate: a match that was shown during a cycle whose actual work went
 * elsewhere (an inbox reply, an unrelated todo) must not silently vanish —
 * see the trigger-firing data-loss incident this replaced (2026-09-25).
 *
 * First-time initialization: if a member has items but no ledger cursor yet,
 * the cursor is anchored at the current HEAD without replaying history —
 * adding a trigger does not backfill a week of matches.
 */

const execFileAsync = promisify(execFile);
const RECORD_SEP = ''; // non-printing, unlikely in commit messages

function makeTriggerId() {
	const iso = new Date().toISOString().replace(/:/g, '-');
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
	return `${iso}-${rand}`;
}

function isValidPriority(p) {
	return PRIORITY_ORDER.includes(p);
}

/**
 * Tiny glob-to-regex. Supports:
 *   `**`  — any run of characters including `/` (consumes a trailing `/` so
 *           `foo/**\/bar` also matches `foo/bar`)
 *   `*`   — any run of non-slash characters
 *   `?`   — a single non-slash character
 * All other regex metacharacters are escaped. Anchored to full-string match.
 */
function globToRegex(glob) {
	let re = '^';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				re += '.*';
				i++;
				if (glob[i + 1] === '/') i++;
			} else {
				re += '[^/]*';
			}
		} else if (c === '?') {
			re += '[^/]';
		} else if ('.+()|^$[]{}\\/'.includes(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	re += '$';
	return new RegExp(re);
}

function compilePaths(patterns) {
	if (!Array.isArray(patterns) || patterns.length === 0) return null;
	return patterns.map(globToRegex);
}

function matchesAuthor(trigger, author, email) {
	if (trigger.authorNot) {
		if (author === trigger.authorNot || email === trigger.authorNot) return false;
	}
	if (trigger.author) {
		if (author !== trigger.author && email !== trigger.author) return false;
	}
	return true;
}

function matchesPaths(compiled, files) {
	if (!compiled) return true;
	return files.some((f) => compiled.some((re) => re.test(f)));
}

function matchesSubject(trigger, subject) {
	if (!trigger.messageMatches) return true;
	try {
		return new RegExp(trigger.messageMatches).test(subject);
	} catch {
		return false;
	}
}

function normalizeTrigger(entry) {
	if (!entry || typeof entry !== 'object') return null;
	const out = {};
	out.id = typeof entry.id === 'string' && entry.id ? entry.id : makeTriggerId();
	out.priority = isValidPriority(entry.priority) ? entry.priority : null;
	if (!out.priority) return null;
	if (typeof entry.reason === 'string' && entry.reason) out.reason = entry.reason;
	if (Array.isArray(entry.paths)) {
		const paths = entry.paths.filter((p) => typeof p === 'string' && p);
		if (paths.length) out.paths = paths;
	}
	if (typeof entry.author === 'string' && entry.author) out.author = entry.author;
	if (typeof entry.authorNot === 'string' && entry.authorNot) out.authorNot = entry.authorNot;
	if (typeof entry.messageMatches === 'string' && entry.messageMatches) {
		out.messageMatches = entry.messageMatches;
	}
	return out;
}

/** Highest-priority (lowest PRIORITY_ORDER index) trigger among these ids, given the current item list. */
function bestPriorityOf(triggerIds, items) {
	let best = null;
	for (const id of triggerIds) {
		const trigger = items.find((i) => i.id === id);
		if (!trigger) continue;
		const idx = PRIORITY_ORDER.indexOf(trigger.priority);
		const bestIdx = best == null ? Number.POSITIVE_INFINITY : PRIORITY_ORDER.indexOf(best);
		if (idx < bestIdx) best = trigger.priority;
	}
	return best;
}

/** Evaluate every trigger's filters against every commit; returns one CommitMatch per matching commit. */
function computeMatches(commits, items, member, matchedAt) {
	const matches = [];
	for (const commit of commits) {
		const matchedIds = [];
		for (const trigger of items) {
			const compiled = compilePaths(trigger.paths);
			// Default: skip commits authored by the member themselves. Triggers
			// override by setting `author` or explicitly matching themselves.
			const effectiveAuthorNot = trigger.authorNot ?? (trigger.author ? null : member);
			if (effectiveAuthorNot && (commit.author === effectiveAuthorNot || commit.email === effectiveAuthorNot)) continue;
			if (!matchesAuthor(trigger, commit.author, commit.email)) continue;
			if (!matchesPaths(compiled, commit.files)) continue;
			if (!matchesSubject(trigger, commit.subject)) continue;
			matchedIds.push(trigger.id);
		}
		if (matchedIds.length === 0) continue;
		matches.push({
			hash: commit.hash,
			shortHash: commit.hash.slice(0, 8),
			author: commit.author,
			email: commit.email,
			subject: commit.subject,
			files: commit.files,
			matchedTriggerIds: matchedIds,
			priority: bestPriorityOf(matchedIds, items),
			matchedAt,
		});
	}
	return matches;
}

export class FileTriggersAdapter {
	constructor(teamDir, repoRoot) {
		this.teamDir = teamDir;
		this.repoRoot = repoRoot;
		// Per-member memo of the HEAD we've already scanned up to this pass.
		// Avoids running `git log` 4× per priority × N members inside a single
		// pass — the ledger itself (not this cache) is what makes a match durable.
		this._scannedTo = new Map(); // member → head SHA
	}

	_path(member) {
		return join(this.teamDir, 'members', member, 'triggers.json');
	}

	/** Scan cursor + durable match ledger — runner-managed, gitignored, churns freely. */
	_ledgerPath(member) {
		return join(this.teamDir, '.logs', 'triggers', `${member}.json`);
	}

	async _readItemsRaw(member) {
		try {
			const raw = await readFile(this._path(member), 'utf-8');
			const data = JSON.parse(raw);
			return {
				items: Array.isArray(data.items) ? data.items : [],
				// Pre-split files carried the cursor inline — migrated in _loadNormalized.
				legacyCursor: typeof data.cursor === 'string' ? data.cursor : null,
			};
		} catch {
			return { items: [], legacyCursor: null };
		}
	}

	async _writeItems(member, items) {
		const path = this._path(member);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify({ items: items ?? [] }, null, '\t')}\n`, 'utf-8');
	}

	async _readLedgerRaw(member) {
		try {
			const raw = await readFile(this._ledgerPath(member), 'utf-8');
			const data = JSON.parse(raw);
			return {
				cursor: typeof data.cursor === 'string' ? data.cursor : null,
				matches: Array.isArray(data.matches) ? data.matches : [],
			};
		} catch {
			return { cursor: null, matches: [] };
		}
	}

	async _writeLedger(member, ledger) {
		const path = this._ledgerPath(member);
		await mkdir(dirname(path), { recursive: true });
		const body = { cursor: ledger.cursor ?? null, matches: ledger.matches ?? [] };
		await writeFile(path, `${JSON.stringify(body, null, '\t')}\n`, 'utf-8');
	}

	async _loadNormalized(member) {
		const raw = await this._readItemsRaw(member);
		let itemsMutated = false;
		const items = [];
		for (const entry of raw.items) {
			const n = normalizeTrigger(entry);
			if (!n) {
				itemsMutated = true;
				continue;
			}
			if (n !== entry) itemsMutated = true;
			items.push(n);
		}

		const ledger = await this._readLedgerRaw(member);
		let ledgerMutated = false;

		// Upgrade path: a pre-split triggers.json carried the cursor inline. Adopt
		// it as the initial scan position rather than re-anchoring at HEAD, which
		// would silently skip whatever range was already pending. Only applies
		// once — after this, the ledger file is the source of truth for cursor.
		if (raw.legacyCursor && !ledger.cursor) {
			ledger.cursor = raw.legacyCursor;
			ledgerMutated = true;
			itemsMutated = true; // rewrite triggers.json without the legacy field
		}

		// Drop ledger references to triggers that no longer exist (removed via
		// remove_trigger, or dropped above as invalid). A match with no surviving
		// trigger id is meaningless and would otherwise linger forever.
		const validIds = new Set(items.map((t) => t.id));
		const keptMatches = [];
		for (const m of ledger.matches) {
			const remaining = (m.matchedTriggerIds ?? []).filter((id) => validIds.has(id));
			if (remaining.length === 0) {
				ledgerMutated = true;
				continue;
			}
			if (remaining.length !== m.matchedTriggerIds.length) {
				ledgerMutated = true;
				keptMatches.push({ ...m, matchedTriggerIds: remaining, priority: bestPriorityOf(remaining, items) });
			} else {
				keptMatches.push(m);
			}
		}
		ledger.matches = keptMatches;

		if (itemsMutated) await this._writeItems(member, items);
		if (ledgerMutated) await this._writeLedger(member, ledger);
		return { items, ledger };
	}

	async listTriggers(member) {
		const { items } = await this._loadNormalized(member);
		return items;
	}

	async addTrigger(member, input) {
		if (!input || typeof input !== 'object') throw new Error('add_trigger: input required');
		if (!isValidPriority(input.priority)) {
			throw new Error(`add_trigger: priority must be one of ${PRIORITY_ORDER.join(', ')}`);
		}
		const state = await this._loadNormalized(member);
		const trigger = normalizeTrigger({ ...input, id: makeTriggerId() });
		if (!trigger) throw new Error('add_trigger: invalid trigger');
		state.items.push(trigger);
		await this._writeItems(member, state.items);
		// First trigger for this member — anchor the cursor at HEAD so we don't
		// replay git history.
		if (!state.ledger.cursor) {
			state.ledger.cursor = await this._readHead();
			await this._writeLedger(member, state.ledger);
		}
		this._scannedTo.delete(member);
		return { id: trigger.id };
	}

	async updateTrigger(member, id, patch) {
		if (!id) throw new Error('update_trigger: id is required');
		if (!patch || typeof patch !== 'object') throw new Error('update_trigger: patch required');
		const state = await this._loadNormalized(member);
		const idx = state.items.findIndex((t) => t.id === id);
		if (idx === -1) throw new Error(`update_trigger: ${id} is not in ${member}'s triggers`);

		const current = state.items[idx];
		const next = { ...current };
		if (patch.priority !== undefined) {
			if (!isValidPriority(patch.priority)) {
				throw new Error(`update_trigger: priority must be one of ${PRIORITY_ORDER.join(', ')}`);
			}
			next.priority = patch.priority;
		}
		if (patch.reason !== undefined) {
			if (patch.reason === null || patch.reason === '') next.reason = undefined;
			else next.reason = String(patch.reason);
		}
		if (patch.paths !== undefined) {
			if (patch.paths === null || (Array.isArray(patch.paths) && patch.paths.length === 0)) {
				next.paths = undefined;
			} else if (Array.isArray(patch.paths)) {
				next.paths = patch.paths.filter((p) => typeof p === 'string' && p);
				if (!next.paths.length) next.paths = undefined;
			} else {
				throw new Error('update_trigger: paths must be an array of glob strings');
			}
		}
		if (patch.author !== undefined) {
			if (patch.author === null || patch.author === '') next.author = undefined;
			else next.author = String(patch.author);
		}
		if (patch.authorNot !== undefined) {
			if (patch.authorNot === null || patch.authorNot === '') next.authorNot = undefined;
			else next.authorNot = String(patch.authorNot);
		}
		if (patch.messageMatches !== undefined) {
			if (patch.messageMatches === null || patch.messageMatches === '') {
				next.messageMatches = undefined;
			} else {
				// Validate that the regex compiles so bad patterns are caught at
				// mutation time, not later during a scan.
				try {
					new RegExp(String(patch.messageMatches));
				} catch (e) {
					throw new Error(`update_trigger: messageMatches invalid regex: ${e.message}`);
				}
				next.messageMatches = String(patch.messageMatches);
			}
		}
		state.items[idx] = next;
		await this._writeItems(member, state.items);
		this._scannedTo.delete(member);
	}

	async removeTrigger(member, id) {
		if (!id) throw new Error('remove_trigger: id is required');
		const state = await this._loadNormalized(member);
		const idx = state.items.findIndex((t) => t.id === id);
		if (idx === -1) throw new Error(`remove_trigger: ${id} is not in ${member}'s triggers`);
		state.items.splice(idx, 1);
		await this._writeItems(member, state.items);

		// Drop this trigger's share of any ledger matches immediately, rather than
		// waiting for the next _loadNormalized cleanup pass.
		let ledgerMutated = false;
		const keptMatches = [];
		for (const m of state.ledger.matches) {
			if (!m.matchedTriggerIds.includes(id)) {
				keptMatches.push(m);
				continue;
			}
			ledgerMutated = true;
			const remaining = m.matchedTriggerIds.filter((tid) => tid !== id);
			if (remaining.length > 0) {
				keptMatches.push({ ...m, matchedTriggerIds: remaining, priority: bestPriorityOf(remaining, state.items) });
			}
		}
		if (ledgerMutated) {
			state.ledger.matches = keptMatches;
			await this._writeLedger(member, state.ledger);
		}
		this._scannedTo.delete(member);
	}

	async _readHead() {
		try {
			const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
				cwd: this.repoRoot,
			});
			return stdout.trim() || null;
		} catch {
			return null;
		}
	}

	/**
	 * Return every currently-unresolved trigger match for this member — not just
	 * ones discovered this call. A match is durable: once found it stays in the
	 * ledger (and keeps being returned here) until `clearMatches` removes it,
	 * regardless of how many times pendingMatches is called or whether the cycle
	 * that saw it succeeded. The scan cursor itself advances eagerly on every
	 * call (cheap — checking is idempotent, and a match is written to the ledger
	 * before the cursor moves past its commit), independent of cycle outcome.
	 *
	 * Returns an empty array only if the member has no triggers. If git is
	 * momentarily unavailable, still-durable matches are returned even though no
	 * new scan could run.
	 */
	async pendingMatches(member) {
		const state = await this._loadNormalized(member);
		if (state.items.length === 0) return [];

		const head = await this._readHead();
		if (!head) return state.ledger.matches;

		// First-time scan with items but no cursor — anchor at HEAD without
		// replaying history, then return nothing this pass.
		if (!state.ledger.cursor) {
			state.ledger.cursor = head;
			await this._writeLedger(member, state.ledger);
			this._scannedTo.set(member, head);
			return [];
		}

		if (this._scannedTo.get(member) !== head && state.ledger.cursor !== head) {
			const commits = await this._gitLogBetween(state.ledger.cursor, head);
			if (commits == null) {
				// `git log cursor..HEAD` failed (rebased-away cursor, most likely).
				// Reset cursor to HEAD so we stop failing on the next pass. Deliberate:
				// forcing a replay after a branch rewrite would likely produce noise.
				state.ledger.cursor = head;
			} else {
				const known = new Set(state.ledger.matches.map((m) => m.hash));
				const newMatches = computeMatches(commits, state.items, member, new Date().toISOString());
				for (const m of newMatches) {
					if (!known.has(m.hash)) state.ledger.matches.push(m);
				}
				state.ledger.cursor = head;
			}
			await this._writeLedger(member, state.ledger);
		}
		this._scannedTo.set(member, head);
		return state.ledger.matches;
	}

	async hasPendingMatches(member, priority) {
		const ceiling = PRIORITY_ORDER.indexOf(priority);
		if (ceiling < 0) return false;
		const matches = await this.pendingMatches(member);
		return matches.some((m) => PRIORITY_ORDER.indexOf(m.priority) <= ceiling);
	}

	/**
	 * Explicitly resolve matches so they stop appearing. Two independent
	 * selectors, combinable:
	 *   - `triggerId` — clear this trigger's share of every match it currently
	 *     has (a match still shows if a DIFFERENT trigger the caller didn't name
	 *     also matched it). The common case: a cycle disposes of one trigger's
	 *     whole fired batch as a single review.
	 *   - `hashes` — clear these exact commits outright, for every trigger that
	 *     matched them, regardless of triggerId.
	 * Passing both scopes to just that trigger's reference on those hashes.
	 * At least one is required. Returns how many match records were touched
	 * (removed entirely, or had this trigger's id dropped from them).
	 */
	async clearMatches(member, { triggerId, hashes } = {}) {
		const hasHashes = Array.isArray(hashes) && hashes.length > 0;
		const hasTrigger = typeof triggerId === 'string' && triggerId.length > 0;
		if (!hasHashes && !hasTrigger) {
			throw new Error('clear_trigger_matches: pass `triggerId`, `hashes`, or both');
		}
		const state = await this._loadNormalized(member);
		if (hasTrigger && !state.items.some((t) => t.id === triggerId)) {
			throw new Error(`clear_trigger_matches: ${triggerId} is not in ${member}'s triggers`);
		}
		const targetHashes = hasHashes ? new Set(hashes) : null;

		let cleared = 0;
		const next = [];
		for (const m of state.ledger.matches) {
			const hashSelected = !targetHashes || targetHashes.has(m.hash) || targetHashes.has(m.shortHash);
			if (!hashSelected) {
				next.push(m);
				continue;
			}
			if (!hasTrigger) {
				cleared++;
				continue; // no triggerId given — drop this hash entirely
			}
			if (!m.matchedTriggerIds.includes(triggerId)) {
				next.push(m);
				continue;
			}
			cleared++;
			const remaining = m.matchedTriggerIds.filter((id) => id !== triggerId);
			if (remaining.length > 0) {
				next.push({ ...m, matchedTriggerIds: remaining, priority: bestPriorityOf(remaining, state.items) });
			}
		}
		state.ledger.matches = next;
		await this._writeLedger(member, state.ledger);
		return { cleared };
	}

	/**
	 * `git log cursor..HEAD --no-merges --name-only` with a record separator
	 * between commits, so we can parse the mixed header/file output.
	 *
	 * Returns null on git error (invalid cursor, not a repo, git missing) so
	 * callers can reset the cursor and move on.
	 */
	async _gitLogBetween(cursor, head) {
		const format = `${RECORD_SEP}%H%n%an%n%ae%n%s`;
		try {
			const { stdout } = await execFileAsync(
				'git',
				['log', `${cursor}..${head}`, '--no-merges', '--name-only', `--format=${format}`],
				{ cwd: this.repoRoot, maxBuffer: 16 * 1024 * 1024 },
			);
			return parseGitLog(stdout);
		} catch {
			return null;
		}
	}
}

/**
 * Parse the mixed --format + --name-only output. Each commit record starts
 * with a RECORD_SEP line, followed by hash, author, email, subject, a blank
 * line, then any number of file paths, then a blank line before the next
 * record. The first record's separator may be at position 0 of stdout.
 */
export function parseGitLog(stdout) {
	if (!stdout) return [];
	const chunks = stdout
		.split(RECORD_SEP)
		.map((s) => s.replace(/^\n/, ''))
		.filter((s) => s.trim());
	const commits = [];
	for (const chunk of chunks) {
		const lines = chunk.split('\n');
		const hash = lines[0];
		const author = lines[1] ?? '';
		const email = lines[2] ?? '';
		const subject = lines[3] ?? '';
		if (!hash) continue;
		// Lines 4+ are files, with blank lines to discard.
		const files = lines
			.slice(4)
			.map((l) => l.trim())
			.filter(Boolean);
		commits.push({ hash, author, email, subject, files });
	}
	return commits;
}
