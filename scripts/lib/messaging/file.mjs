import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathExists } from '../util.mjs';

/**
 * File-based messaging adapter.
 *
 * Implements the email-like protocol described in teamos/docs/messages.md:
 *   - Master store at team/messages/<id>.md (one file per message)
 *   - Per-member mailboxes as JSON id lists:
 *       team/members/<name>/inbox.json
 *       team/members/<name>/sent.json
 *       team/members/<name>/archives.json
 */

function makeMessageId() {
	const iso = new Date().toISOString().replace(/:/g, '-'); // 2026-04-13T10-30-45.123Z
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
	return `${iso}-${rand}`;
}

function parseFrontmatterValue(raw) {
	const trimmed = raw.trim();
	if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
		const inner = trimmed.slice(1, -1).trim();
		if (!inner) return [];
		return inner
			.split(',')
			.map((s) => s.trim().replace(/^["']|["']$/g, ''))
			.filter(Boolean);
	}
	return trimmed;
}

function parseFrontmatter(content) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { metadata: {}, body: content.trim() };

	const metadata = {};
	for (const line of match[1].split('\n')) {
		const colonIdx = line.indexOf(':');
		if (colonIdx <= 0) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1);
		metadata[key] = parseFrontmatterValue(value);
	}
	return { metadata, body: match[2].trim() };
}

function serializeMessage(msg) {
	const lines = ['---'];
	lines.push(`id: ${msg.id}`);
	lines.push(`from: ${msg.from}`);
	lines.push(`to: [${(msg.to ?? []).join(', ')}]`);
	if (msg.cc?.length) lines.push(`cc: [${msg.cc.join(', ')}]`);
	lines.push(`subject: ${msg.subject ?? ''}`);
	lines.push(`sentAt: ${msg.sentAt}`);
	if (msg.replyTo) lines.push(`replyTo: ${msg.replyTo}`);
	if (msg.supersedes?.length) lines.push(`supersedes: [${msg.supersedes.join(', ')}]`);
	if (msg.supersededBy) lines.push(`supersededBy: ${msg.supersededBy}`);
	if (msg.projectCode) lines.push(`projectCode: ${msg.projectCode}`);
	if (msg.ask) lines.push(`ask: ${msg.ask}`);
	if (msg.default) lines.push(`default: ${oneLine(msg.default)}`);
	if (msg.defaultBy) lines.push(`defaultBy: ${msg.defaultBy}`);
	if (msg.resolves) lines.push(`resolves: ${msg.resolves}`);
	if (msg.resolvedBy) lines.push(`resolvedBy: ${msg.resolvedBy}`);
	if (msg.resolvedAt) lines.push(`resolvedAt: ${msg.resolvedAt}`);
	if (msg.resolution) lines.push(`resolution: ${msg.resolution}`);
	lines.push('---', '', (msg.body ?? '').trimEnd(), '');
	return lines.join('\n');
}

/** A frontmatter value is one line; a newline in it would start a forged field. */
function oneLine(value) {
	return String(value ?? '')
		.replace(/[\r\n]+/g, ' ')
		.trim();
}

/** A string field, or undefined. An array (a value that happened to look like `[...]`) is rejoined. */
function optionalString(value) {
	if (Array.isArray(value)) return value.length ? value.join(', ') : undefined;
	return typeof value === 'string' && value ? value : undefined;
}

function normalizeMessage(metadata, body) {
	const supersedes = Array.isArray(metadata.supersedes)
		? metadata.supersedes
		: metadata.supersedes
			? [metadata.supersedes]
			: [];
	return {
		id: typeof metadata.id === 'string' ? metadata.id : '',
		from: typeof metadata.from === 'string' ? metadata.from : 'unknown',
		to: Array.isArray(metadata.to) ? metadata.to : metadata.to ? [metadata.to] : [],
		cc: Array.isArray(metadata.cc) ? metadata.cc : metadata.cc ? [metadata.cc] : [],
		subject: typeof metadata.subject === 'string' ? metadata.subject : '',
		sentAt: typeof metadata.sentAt === 'string' ? metadata.sentAt : '',
		replyTo: typeof metadata.replyTo === 'string' && metadata.replyTo ? metadata.replyTo : undefined,
		supersedes,
		supersededBy:
			typeof metadata.supersededBy === 'string' && metadata.supersededBy ? metadata.supersededBy : undefined,
		projectCode: typeof metadata.projectCode === 'string' && metadata.projectCode ? metadata.projectCode : undefined,
		// Untagged (legacy) messages simply have no `ask`.
		ask: ASK_VALUES.includes(metadata.ask) ? metadata.ask : undefined,
		default: optionalString(metadata.default),
		defaultBy: optionalString(metadata.defaultBy),
		resolves: optionalString(metadata.resolves),
		resolvedBy: optionalString(metadata.resolvedBy),
		resolvedAt: optionalString(metadata.resolvedAt),
		resolution: optionalString(metadata.resolution),
		body,
	};
}

function stripReplyPrefix(subject) {
	return (subject ?? '').replace(/^(re:\s*)+/i, '').trim();
}

function recipientsOf(msg) {
	return [...(msg.to ?? []), ...(msg.cc ?? [])];
}


// ─── Asks: what a message to a human wants from them ──────────────────────────
//
// A human member gets far more mail than they can read, and most of it does
// not need them. So a message an agent *initiates* to a human (no `replyTo`)
// must say what it wants:
//
//   ask: decide — one standalone question. Carries `default` (what happens if
//                 the human says nothing) and `defaultBy` (when it happens).
//                 Silence means the default goes ahead; nobody waits.
//   ask: fyi    — no attention needed. Delivered to the human's archives, not
//                 their inbox, and shown in the dashboard's FYI digest.
//
// Replies are conversational and need no `ask`. Messages from a human are not
// checked. Messages written before this rule have no `ask` and read as
// untagged. A `decide` closes (resolvedBy is written onto it) when a human
// recipient replies in its thread, or when its sender sends a message with
// `resolves: <id>` once `defaultBy` has passed, saying the default was applied.

export const ASK_VALUES = ['decide', 'fyi'];

/** Longest `default` accepted. It is a one-line summary; the reasoning goes in the body. */
const MAX_DEFAULT_LENGTH = 300;

/** How far up a reply chain a human's reply looks for the question it answers. */
const MAX_RESOLVE_DEPTH = 32;

/** A bad message: the sender's mistake, so the dashboard answers 400 rather than 500. */
export class MessageValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'MessageValidationError';
		this.status = 400;
	}
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The moment a `defaultBy` passes, in ms. A bare date runs to the end of that
 * day, UTC. NaN when it isn't an ISO date.
 */
export function defaultDeadline(defaultBy) {
	if (typeof defaultBy !== 'string' || !ISO_DATE.test(defaultBy.trim())) return Number.NaN;
	const v = defaultBy.trim();
	return Date.parse(v.length === 10 ? `${v}T23:59:59.999Z` : v);
}

/** True once a decide's `defaultBy` has passed and its default may go ahead. */
export function isOverdue(msg, now = Date.now()) {
	const deadline = defaultDeadline(msg?.defaultBy);
	return Number.isFinite(deadline) && now > deadline;
}

const ASK_HOW_TO = [
	'Pick one:',
	'- `ask: "decide"` — you need exactly one decision from them. Make the body standalone: what this is, where it lives (ticket path, file, message id, commit), what has happened so far, why it matters now, and the options. Also pass `default` (what you will do if they don\'t answer, one line) and `defaultBy` (ISO date, e.g. "2026-11-20", after which you go ahead with the default).',
	'- `ask: "fyi"` — nothing is needed from them. It goes to their FYI digest, not their inbox. Send these sparingly; most status belongs in your own docs or with teammates.',
	'Replies (`replyTo` set) need no `ask`.',
].join('\n');

export class FileMessagingAdapter {
	constructor(teamDir) {
		this.teamDir = teamDir;
		this.messagesDir = join(teamDir, 'messages');
	}

	// ─── Paths ─────────────────────────────────────────────────────────────────

	_messagePath(id) {
		return join(this.messagesDir, `${id}.md`);
	}

	_mailboxPath(member, kind) {
		return join(this.teamDir, 'members', member, `${kind}.json`);
	}

	// ─── Roster validation ─────────────────────────────────────────────────────
	//
	// Message-party names (from, to, cc) must match members.json exactly. On
	// case-insensitive filesystems (macOS/Windows) a misspelled case writes to
	// the same directory; on case-sensitive filesystems (Linux) it creates a
	// phantom sibling directory — and the two diverge the moment you sync a
	// repo between the two. Validating here catches drift at the source.

	/** members.json entries with a name, or null when there is no readable roster. */
	async _loadRoster() {
		const path = join(this.teamDir, 'members.json');
		try {
			const raw = await readFile(path, 'utf-8');
			const data = JSON.parse(raw);
			if (!Array.isArray(data.members)) return null;
			return data.members.filter((m) => typeof m?.name === 'string' && m.name.length > 0);
		} catch {
			return null;
		}
	}

	async _loadRosterNames() {
		const roster = await this._loadRoster();
		return roster ? roster.map((m) => m.name) : null;
	}

	/** Names of human members (`type: "human"` in members.json). Empty without a roster. */
	async humanMembers() {
		const roster = await this._loadRoster();
		return new Set((roster ?? []).filter((m) => m.type === 'human').map((m) => m.name));
	}

	_assertInRoster(role, name, roster) {
		if (roster.includes(name)) return;
		const lower = name.toLowerCase();
		const caseMatch = roster.find((n) => n.toLowerCase() === lower);
		if (caseMatch) {
			throw new Error(
				`${role}: "${name}" does not match roster case — members.json declares "${caseMatch}". Use the canonical name to avoid phantom directories on case-sensitive filesystems.`,
			);
		}
		throw new Error(`${role}: "${name}" is not in members.json (known: ${roster.join(', ')}).`);
	}

	async _validateParties(op, from, to, cc) {
		const roster = await this._loadRosterNames();
		if (!roster) return; // No roster file → skip (e.g. test harness)
		this._assertInRoster(`${op}.from`, from, roster);
		for (const r of to) this._assertInRoster(`${op}.to`, r, roster);
		for (const r of cc ?? []) this._assertInRoster(`${op}.cc`, r, roster);
	}

	// ─── Mailbox helpers ───────────────────────────────────────────────────────

	async _readMailbox(member, kind) {
		const path = this._mailboxPath(member, kind);
		try {
			const raw = await readFile(path, 'utf-8');
			const data = JSON.parse(raw);
			return Array.isArray(data.items) ? data.items : [];
		} catch {
			return [];
		}
	}

	_readMailboxSync(member, kind) {
		try {
			const data = JSON.parse(readFileSync(this._mailboxPath(member, kind), 'utf-8'));
			return Array.isArray(data.items) ? data.items : [];
		} catch {
			return [];
		}
	}

	/**
	 * Replace a mailbox through a temp file and a rename, so a reader never
	 * sees it half-written. A truncated read parses as an empty mailbox: the
	 * dashboard showed that member's inbox as all handled for one refresh, and
	 * a read-modify-write that caught it wrote the empty list back for good.
	 */
	_writeMailboxSync(member, kind, items) {
		const path = this._mailboxPath(member, kind);
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ items }, null, '\t')}\n`, 'utf-8');
		renameSync(tmp, path);
	}

	/**
	 * Read-modify-write a member's mailboxes as one step.
	 *
	 * A mailbox is a JSON list rewritten whole, and every change to one is a
	 * read-modify-write: a delivery appends, archive and unarchive move an id
	 * between two lists. Done with awaits between the read and the write, two
	 * of them interleave and the second writes back what the first removed —
	 * archive two messages at once from the dashboard and one of them lands
	 * back in the inbox, dropped from archives. Here the reads, the change and
	 * the writes run synchronously, so nothing in this process can interleave,
	 * and the window against another process (a member's MCP server delivering
	 * mail) is the few microseconds between a read and a rename. Closing that
	 * too would mean a lock file, which this codebase deliberately does not
	 * have.
	 *
	 * `change` gets the lists by kind and mutates them in place, returning the
	 * kinds it changed; only those are written.
	 */
	_updateMailboxes(member, kinds, change) {
		mkdirSync(dirname(this._mailboxPath(member, kinds[0])), { recursive: true });
		const boxes = Object.fromEntries(kinds.map((kind) => [kind, this._readMailboxSync(member, kind)]));
		const changed = change(boxes);
		for (const kind of changed) this._writeMailboxSync(member, kind, boxes[kind]);
		return changed.length > 0;
	}

	/** Append one id to a mailbox; a no-op when it is already there. */
	async _appendToMailbox(member, kind, id) {
		this._updateMailboxes(member, [kind], (boxes) => {
			if (boxes[kind].includes(id)) return [];
			boxes[kind].push(id);
			return [kind];
		});
	}

	async _removeFromMailbox(member, kind, id) {
		return this._updateMailboxes(member, [kind], (boxes) => {
			const idx = boxes[kind].indexOf(id);
			if (idx === -1) return [];
			boxes[kind].splice(idx, 1);
			return [kind];
		});
	}

	/** Move an id from one mailbox to another. `missing` runs when it is in neither. */
	_moveBetweenMailboxes(member, from, to, id, missing) {
		this._updateMailboxes(member, [from, to], (boxes) => {
			const idx = boxes[from].indexOf(id);
			if (idx === -1) {
				if (boxes[to].includes(id)) return []; // already moved, no-op
				missing();
				return [];
			}
			boxes[from].splice(idx, 1);
			if (!boxes[to].includes(id)) boxes[to].push(id);
			return [from, to];
		});
	}


	// ─── Ask validation, delivery and resolution ───────────────────────────────

	/**
	 * Check the ask fields of an outgoing message and return the ones to store.
	 * Throws a MessageValidationError that says how to fix the message.
	 */
	async _checkAsk(op, msg, humans) {
		const { from, to, cc, replyTo } = msg;
		const fields = {
			ask: msg.ask || undefined,
			default: msg.default == null ? undefined : oneLine(msg.default) || undefined,
			defaultBy: msg.defaultBy == null ? undefined : String(msg.defaultBy).trim() || undefined,
			resolves: msg.resolves ? oneLine(msg.resolves) || undefined : undefined,
		};
		// A human writes what they like, and their asks mean nothing to anyone.
		if (humans.has(from)) {
			return { ask: undefined, default: undefined, defaultBy: undefined, resolves: fields.resolves };
		}
		const humanRecipients = [...new Set([...(to ?? []), ...(cc ?? [])])].filter((r) => humans.has(r));
		const fail = (text) => {
			throw new MessageValidationError(`${op}: ${text}`);
		};

		if (fields.ask !== undefined && !ASK_VALUES.includes(fields.ask)) {
			fail(`ask must be "decide" or "fyi", not ${JSON.stringify(fields.ask)}.\n${ASK_HOW_TO}`);
		}
		// A `resolves` threads under its question, so it is a reply too.
		const isReply = !!replyTo || !!fields.resolves;
		if (!isReply && humanRecipients.length > 0 && !fields.ask) {
			fail(
				`${humanRecipients.join(', ')} ${humanRecipients.length === 1 ? 'is a human member' : 'are human members'}, and a new message to a human must say what it wants from them.\n${ASK_HOW_TO}`,
			);
		}
		if (fields.ask === 'decide') {
			if (humanRecipients.length === 0) {
				fail('ask: "decide" is for a question to a human member, and no recipient is human. Drop `ask` for mail between agents.');
			}
			if (!fields.default) {
				fail('ask: "decide" needs `default`: one line saying what you will do if there is no answer. Silence means the default goes ahead, so nobody waits.');
			}
			if (fields.default.length > MAX_DEFAULT_LENGTH) {
				fail(`\`default\` is ${fields.default.length} characters; keep it to one line (${MAX_DEFAULT_LENGTH} at most) and put the reasoning in the body.`);
			}
			if (!fields.defaultBy) {
				fail('ask: "decide" needs `defaultBy`: an ISO date (e.g. "2026-11-20") after which the default goes ahead if there is no answer.');
			}
			const deadline = defaultDeadline(fields.defaultBy);
			if (!Number.isFinite(deadline)) {
				fail(`\`defaultBy\` must be an ISO date such as "2026-11-20" or "2026-11-20T17:00:00Z", not ${JSON.stringify(fields.defaultBy)}.`);
			}
			if (deadline <= Date.now()) {
				fail(`\`defaultBy\` ${fields.defaultBy} has already passed. Give the human a real chance to answer: pick a date in the future.`);
			}
		} else if (fields.default !== undefined || fields.defaultBy !== undefined) {
			fail('`default` and `defaultBy` only apply to ask: "decide". Drop them, or make this a decide.');
		}

		if (fields.resolves !== undefined) {
			const target = await this._readRawMessage(fields.resolves).catch(() => null);
			if (!target) fail(`resolves: message ${fields.resolves} not found.`);
			if (target.ask !== 'decide') fail(`resolves: ${fields.resolves} is not an ask: "decide" message, so there is nothing to resolve.`);
			if (target.resolvedBy) fail(`resolves: ${fields.resolves} is already resolved by ${target.resolvedBy}.`);
			if (target.from !== from) {
				fail(`resolves: ${fields.resolves} was asked by ${target.from}; only the sender (or a human recipient, by replying) can resolve it.`);
			}
			if (!isOverdue(target)) {
				fail(`resolves: the default for ${fields.resolves} is not due until after ${target.defaultBy}. Wait for an answer until then. If the question is moot, supersede it with an ask: "fyi" saying so.`);
			}
		}
		return fields;
	}

	/**
	 * Deliver to each recipient. An FYI, or a note that a default was applied,
	 * needs nothing from a human, so it goes straight to their archives: it
	 * stays in the record and the digest but never reads as waiting on them.
	 */
	async _deliver(msg, humans) {
		const quiet = !humans.has(msg.from) && (msg.ask === 'fyi' || !!msg.resolves);
		for (const recipient of [...new Set([...msg.to, ...(msg.cc ?? [])])]) {
			const box = quiet && humans.has(recipient) ? 'archives' : 'inbox';
			await this._appendToMailbox(recipient, box, msg.id);
		}
		await this._appendToMailbox(msg.from, 'sent', msg.id);
	}

	/** Mark a decide closed and take it out of its human recipients' inboxes. */
	async _resolve(target, byId, resolution, humans) {
		const updated = { ...target, resolvedBy: byId, resolvedAt: new Date().toISOString(), resolution };
		await writeFile(this._messagePath(target.id), serializeMessage(updated), 'utf-8');
		for (const r of recipientsOf(target)) {
			if (humans.has(r)) this._moveBetweenMailboxes(r, 'inbox', 'archives', target.id, () => {});
		}
	}

	/**
	 * After a send: an explicit `resolves` closes its target; a human's reply
	 * closes the nearest open decide up its thread that was put to them.
	 */
	async _applyResolution(msg, humans) {
		if (msg.resolves) {
			const target = await this._readRawMessage(msg.resolves).catch(() => null);
			if (target && target.ask === 'decide' && !target.resolvedBy) {
				await this._resolve(target, msg.id, humans.has(msg.from) ? 'answered' : 'default-applied', humans);
			}
			return;
		}
		if (!humans.has(msg.from) || !msg.replyTo) return;
		const seen = new Set();
		let cur = msg.replyTo;
		for (let i = 0; cur && i < MAX_RESOLVE_DEPTH && !seen.has(cur); i++) {
			seen.add(cur);
			const node = await this._readRawMessage(cur).catch(() => null);
			if (!node) return;
			if (node.ask === 'decide' && !node.resolvedBy && !node.supersededBy && recipientsOf(node).includes(msg.from)) {
				await this._resolve(node, msg.id, 'answered', humans);
				return;
			}
			cur = node.replyTo;
		}
	}

	// ─── Core operations ───────────────────────────────────────────────────────

	async hasMessages(member) {
		const summaries = await this.listInbox(member);
		return summaries.length > 0;
	}

	async sendMessage(args) {
		const { from, to, cc, subject, body, projectCode } = args;
		let { replyTo } = args;
		if (!from) throw new Error('sendMessage: from is required');
		if (!Array.isArray(to) || to.length === 0) throw new Error('sendMessage: to is required');
		if (body == null) throw new Error('sendMessage: body is required');

		await this._validateParties('sendMessage', from, to, cc);
		const humans = await this.humanMembers();
		const ask = await this._checkAsk('sendMessage', { ...args, replyTo }, humans);
		// A resolution threads under the question it closes.
		if (ask.resolves && !replyTo) replyTo = ask.resolves;

		let derivedSubject = subject;
		if ((!derivedSubject || !derivedSubject.trim()) && replyTo) {
			const parent = await this._readRawMessage(replyTo).catch(() => null);
			if (parent) {
				derivedSubject = `Re: ${stripReplyPrefix(parent.subject)}`;
			}
		}
		if (!derivedSubject || !derivedSubject.trim()) {
			throw new Error('sendMessage: subject is required on new threads');
		}

		const id = makeMessageId();
		const sentAt = new Date().toISOString();

		await mkdir(this.messagesDir, { recursive: true });
		const content = serializeMessage({
			id,
			from,
			to,
			cc,
			subject: derivedSubject,
			sentAt,
			replyTo,
			projectCode,
			...ask,
			body,
		});
		await writeFile(this._messagePath(id), content, 'utf-8');

		const sent = { id, from, to, cc, replyTo, ...ask };
		await this._deliver(sent, humans);
		await this._applyResolution(sent, humans);

		return { id, sentAt };
	}

	/**
	 * Send a new message that consolidates / replaces one or more earlier
	 * messages from the same sender. The new message gets `supersedes: [...]`
	 * pointing back at its predecessors; each predecessor is rewritten with
	 * `supersededBy: <newId>` so reverse-traversal is O(1). For every
	 * recipient in the union of the predecessors' to+cc:
	 *   - if the predecessor is still in their inbox, we remove it so they
	 *     only see the consolidated version on next read
	 *   - if they have already archived (or otherwise dropped) the
	 *     predecessor, we leave their archive alone — list_inbox/list_archives
	 *     will mark the lingering copy with supersededBy so the agent knows
	 *
	 * The new message is delivered to its `to`/`cc` recipients using the same
	 * inbox-append rules as `sendMessage`.
	 *
	 * `to` (plus optional `cc`) on the new message must cover every recipient
	 * the predecessors reached — otherwise dropped recipients would be left
	 * with neither the predecessor (if removed from inbox) nor a replacement.
	 */
	async supersedeMessage(args) {
		const { from, supersedes, to, cc, subject, body, projectCode, replyTo } = args;
		if (!from) throw new Error('supersedeMessage: from is required');
		if (!Array.isArray(supersedes) || supersedes.length === 0) {
			throw new Error('supersedeMessage: supersedes must list at least one prior message id');
		}
		if (!Array.isArray(to) || to.length === 0) throw new Error('supersedeMessage: to is required');
		if (body == null) throw new Error('supersedeMessage: body is required');

		await this._validateParties('supersedeMessage', from, to, cc);
		const humans = await this.humanMembers();
		const ask = await this._checkAsk('supersedeMessage', args, humans);
		if (ask.resolves) {
			throw new MessageValidationError('supersedeMessage: `resolves` is not allowed here. Send it with send_message as a reply to the question.');
		}

		// Load and validate every predecessor up front — no partial commits.
		const predecessors = [];
		for (const prevId of supersedes) {
			const prev = await this._readRawMessage(prevId).catch(() => null);
			if (!prev) throw new Error(`supersedeMessage: predecessor ${prevId} not found`);
			if (prev.from !== from) {
				throw new Error(
					`supersedeMessage: ${prevId} was sent by ${prev.from}, not ${from} — only the original sender can supersede`,
				);
			}
			if (prev.supersededBy) {
				throw new Error(`supersedeMessage: ${prevId} is already superseded by ${prev.supersededBy}`);
			}
			predecessors.push(prev);
		}

		const newRecipients = new Set([...to, ...(cc ?? [])]);
		const droppedRecipients = [];
		for (const prev of predecessors) {
			for (const r of recipientsOf(prev)) {
				if (!newRecipients.has(r)) droppedRecipients.push({ id: prev.id, recipient: r });
			}
		}
		if (droppedRecipients.length) {
			const sample = droppedRecipients
				.slice(0, 3)
				.map((d) => `${d.recipient} (from ${d.id})`)
				.join(', ');
			throw new Error(
				`supersedeMessage: new recipients must cover every predecessor recipient. Missing: ${sample}${droppedRecipients.length > 3 ? `, and ${droppedRecipients.length - 3} more` : ''}. To address a smaller audience, send a regular message instead of superseding.`,
			);
		}

		// Fall back to the most recent predecessor's subject if none provided —
		// keeps the thread title stable in inboxes.
		let derivedSubject = subject;
		if (!derivedSubject || !derivedSubject.trim()) {
			derivedSubject = predecessors[predecessors.length - 1].subject;
		}
		if (!derivedSubject || !derivedSubject.trim()) {
			throw new Error('supersedeMessage: subject could not be derived');
		}

		const id = makeMessageId();
		const sentAt = new Date().toISOString();

		await mkdir(this.messagesDir, { recursive: true });
		const content = serializeMessage({
			id,
			from,
			to,
			cc,
			subject: derivedSubject,
			sentAt,
			replyTo,
			supersedes: [...supersedes],
			projectCode,
			...ask,
			body,
		});
		await writeFile(this._messagePath(id), content, 'utf-8');

		// Mark each predecessor with supersededBy + remove from any inbox where
		// it still sits unread (so recipients see only the consolidated message).
		let unreadRemoved = 0;
		const stillReachable = [];
		for (const prev of predecessors) {
			const updated = { ...prev, supersededBy: id };
			await writeFile(this._messagePath(prev.id), serializeMessage(updated), 'utf-8');
			for (const recipient of recipientsOf(prev)) {
				const removed = await this._removeFromMailbox(recipient, 'inbox', prev.id);
				if (removed) unreadRemoved++;
				else stillReachable.push({ id: prev.id, recipient });
			}
		}

		// Deliver the new message normally.
		await this._deliver({ id, from, to, cc, ...ask }, humans);

		return { id, sentAt, supersededIds: [...supersedes], unreadRemoved, alreadyDelivered: stillReachable.length };
	}

	async _readRawMessage(id) {
		const content = await readFile(this._messagePath(id), 'utf-8');
		const { metadata, body } = parseFrontmatter(content);
		return normalizeMessage(metadata, body);
	}

	/**
	 * Read a message from the master store. If `inlineParent` is true (default),
	 * the immediately preceding message (replyTo target) is inlined as `parent`,
	 * one level deep. Deeper history is reached by calling read_message again.
	 */
	async readMessage(id, { inlineParent = true } = {}) {
		const msg = await this._readRawMessage(id);
		if (inlineParent && msg.replyTo) {
			const parent = await this._readRawMessage(msg.replyTo).catch(() => null);
			if (parent) msg.parent = parent;
		}
		return msg;
	}

	async _summariesFromIds(ids) {
		const entries = [];
		for (const id of ids) {
			const msg = await this._readRawMessage(id).catch(() => null);
			if (!msg) continue;
			entries.push({
				id: msg.id,
				from: msg.from,
				to: msg.to,
				cc: msg.cc,
				subject: msg.subject,
				sentAt: msg.sentAt,
				projectCode: msg.projectCode,
				hasParent: !!msg.replyTo,
				supersedes: msg.supersedes?.length ? msg.supersedes : undefined,
				supersededBy: msg.supersededBy,
				ask: msg.ask,
				default: msg.default,
				defaultBy: msg.defaultBy,
				resolves: msg.resolves,
				resolvedBy: msg.resolvedBy,
				resolution: msg.resolution,
			});
		}
		entries.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
		return entries;
	}

	/**
	 * Drop entries whose supersededBy target is also present in `visibleIds`.
	 * The lingering predecessor is hidden because the consolidated version is
	 * reachable in the same mailbox; if the consolidation isn't reachable we
	 * keep the predecessor visible so the recipient never silently loses a
	 * message.
	 */
	_collapseSuperseded(entries, visibleIds) {
		const visible = new Set(visibleIds);
		return entries.filter((e) => !(e.supersededBy && visible.has(e.supersededBy)));
	}

	async listInbox(member) {
		const ids = await this._readMailbox(member, 'inbox');
		const archived = await this._readMailbox(member, 'archives');
		const entries = await this._summariesFromIds(ids);
		// A predecessor is hidden if its consolidated version is reachable in
		// either the inbox or the archives — both count as "the recipient has
		// the new message".
		return this._collapseSuperseded(entries, [...ids, ...archived]);
	}

	/**
	 * @param {string} member
	 * @param {{ to?: string[] }} [opts] — when `to` is provided, only sent
	 *   messages whose to+cc intersects the requested member set are returned.
	 *   Used by agents to find recent threads with a given audience before
	 *   composing or superseding.
	 */
	async listSent(member, opts = {}) {
		const ids = await this._readMailbox(member, 'sent');
		const entries = await this._summariesFromIds(ids);
		const filter = opts.to;
		if (Array.isArray(filter) && filter.length > 0) {
			const want = new Set(filter);
			return entries.filter((e) => {
				const recipients = [...(e.to ?? []), ...(e.cc ?? [])];
				return recipients.some((r) => want.has(r));
			});
		}
		return entries;
	}

	async listArchives(member) {
		const ids = await this._readMailbox(member, 'archives');
		const inbox = await this._readMailbox(member, 'inbox');
		const entries = await this._summariesFromIds(ids);
		return this._collapseSuperseded(entries, [...ids, ...inbox]);
	}

	async archiveMessage(member, id) {
		this._moveBetweenMailboxes(member, 'inbox', 'archives', id, () => {
			throw new Error(`archiveMessage: ${id} is not in ${member}'s inbox`);
		});
	}

	async unarchiveMessage(member, id) {
		this._moveBetweenMailboxes(member, 'archives', 'inbox', id, () => {
			throw new Error(`unarchiveMessage: ${id} is not in ${member}'s archives`);
		});
	}

	/**
	 * Delete a message from a member's inbox without archiving it.
	 * Used by the UI for explicit "discard" actions.
	 */
	async deleteInboxMessage(member, id) {
		await this._removeFromMailbox(member, 'inbox', id);
	}

	async deleteArchivedMessage(member, id) {
		await this._removeFromMailbox(member, 'archives', id);
	}
}
