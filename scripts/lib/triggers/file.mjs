import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { PRIORITY_ORDER } from '../scheduler.mjs';

/**
 * File-backed commit-triggers adapter.
 *
 * Per-member state at team/members/<name>/triggers.json:
 *   {
 *     "cursor": "<SHA the member has been notified through>",
 *     "items": [ CommitTrigger, ... ]
 *   }
 *
 * Triggers subscribe the member to git commits in the host repo. On each pass
 * the runner scans <cursor>..HEAD for commits that match any trigger's filters
 * (paths / author / message) and injects them into the member's cycle prompt
 * as wake reasons. The cursor advances to HEAD-at-cycle-start on successful
 * cycle completion (at-least-once semantics — a failed cycle re-fires).
 *
 * First-time initialization: if triggers.json exists with items but no cursor,
 * the cursor is set to the current HEAD without replaying history. Agents who
 * add a trigger start seeing commits from that point forward.
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

export class FileTriggersAdapter {
	constructor(teamDir, repoRoot) {
		this.teamDir = teamDir;
		this.repoRoot = repoRoot;
		// Per-member memo of the last match scan, keyed on HEAD SHA. Avoids
		// running `git log` 4× per priority × N members inside a single pass.
		this._matchCache = new Map(); // member → { head, matches }
	}

	_path(member) {
		return join(this.teamDir, 'members', member, 'triggers.json');
	}

	async _readRaw(member) {
		try {
			const raw = await readFile(this._path(member), 'utf-8');
			const data = JSON.parse(raw);
			return {
				cursor: typeof data.cursor === 'string' ? data.cursor : null,
				items: Array.isArray(data.items) ? data.items : [],
			};
		} catch {
			return { cursor: null, items: [] };
		}
	}

	async _writeRaw(member, state) {
		const path = this._path(member);
		await mkdir(dirname(path), { recursive: true });
		const body = { cursor: state.cursor ?? null, items: state.items ?? [] };
		await writeFile(path, `${JSON.stringify(body, null, '\t')}\n`, 'utf-8');
	}

	async _loadNormalized(member) {
		const raw = await this._readRaw(member);
		let mutated = false;
		const items = [];
		for (const entry of raw.items) {
			const n = normalizeTrigger(entry);
			if (!n) {
				mutated = true;
				continue;
			}
			if (n !== entry) mutated = true;
			items.push(n);
		}
		const state = { cursor: raw.cursor, items };
		if (mutated) await this._writeRaw(member, state);
		return state;
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
		// First trigger for this member — anchor the cursor at HEAD so we don't
		// replay git history.
		if (!state.cursor) state.cursor = await this._readHead();
		await this._writeRaw(member, state);
		this._matchCache.delete(member);
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
		await this._writeRaw(member, state);
		this._matchCache.delete(member);
	}

	async removeTrigger(member, id) {
		if (!id) throw new Error('remove_trigger: id is required');
		const state = await this._loadNormalized(member);
		const idx = state.items.findIndex((t) => t.id === id);
		if (idx === -1) throw new Error(`remove_trigger: ${id} is not in ${member}'s triggers`);
		state.items.splice(idx, 1);
		await this._writeRaw(member, state);
		this._matchCache.delete(member);
	}

	async currentHead(_member) {
		return this._readHead();
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
	 * Return matching commits between <cursor>..HEAD for every trigger this
	 * member has. The cursor is NOT advanced — call `acknowledgeHead` after a
	 * successful cycle to advance it. Returns an empty array if the member has
	 * no triggers, or if there are no new commits, or if git is unavailable.
	 */
	async pendingMatches(member) {
		const state = await this._loadNormalized(member);
		if (state.items.length === 0) return [];

		const head = await this._readHead();
		if (!head) return [];

		// First-time scan with items but no cursor — anchor at HEAD without
		// replaying history, then return nothing this pass.
		if (!state.cursor) {
			state.cursor = head;
			await this._writeRaw(member, state);
			return [];
		}

		if (state.cursor === head) return [];

		const cached = this._matchCache.get(member);
		if (cached && cached.head === head && cached.cursor === state.cursor) {
			return cached.matches;
		}

		const commits = await this._gitLogBetween(state.cursor, head);
		if (commits == null) {
			// `git log cursor..HEAD` failed (rebased-away cursor, most likely).
			// Reset cursor to HEAD so we stop failing on the next pass.
			state.cursor = head;
			await this._writeRaw(member, state);
			this._matchCache.set(member, { head, cursor: head, matches: [] });
			return [];
		}

		const matches = [];
		for (const commit of commits) {
			const matchedIds = [];
			let bestPriority = null;
			for (const trigger of state.items) {
				const compiled = compilePaths(trigger.paths);
				// Default: skip commits authored by the member themselves. Triggers
				// override by setting `author` or explicitly matching themselves.
				const effectiveAuthorNot = trigger.authorNot ?? (trigger.author ? null : member);
				if (effectiveAuthorNot && (commit.author === effectiveAuthorNot || commit.email === effectiveAuthorNot))
					continue;
				if (!matchesAuthor(trigger, commit.author, commit.email)) continue;
				if (!matchesPaths(compiled, commit.files)) continue;
				if (!matchesSubject(trigger, commit.subject)) continue;
				matchedIds.push(trigger.id);
				const pIdx = PRIORITY_ORDER.indexOf(trigger.priority);
				const bestIdx = bestPriority == null ? Number.POSITIVE_INFINITY : PRIORITY_ORDER.indexOf(bestPriority);
				if (pIdx < bestIdx) bestPriority = trigger.priority;
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
				priority: bestPriority,
			});
		}

		this._matchCache.set(member, { head, cursor: state.cursor, matches });
		return matches;
	}

	async hasPendingMatches(member, priority) {
		const ceiling = PRIORITY_ORDER.indexOf(priority);
		if (ceiling < 0) return false;
		const matches = await this.pendingMatches(member);
		return matches.some((m) => PRIORITY_ORDER.indexOf(m.priority) <= ceiling);
	}

	async acknowledgeHead(member, head) {
		if (!head) return;
		const state = await this._loadNormalized(member);
		if (state.items.length === 0 && !state.cursor) return;
		if (state.cursor === head) return;
		state.cursor = head;
		await this._writeRaw(member, state);
		this._matchCache.delete(member);
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
