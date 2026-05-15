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
	lines.push('---', '', (msg.body ?? '').trimEnd(), '');
	return lines.join('\n');
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
		body,
	};
}

function stripReplyPrefix(subject) {
	return (subject ?? '').replace(/^(re:\s*)+/i, '').trim();
}

function recipientsOf(msg) {
	return [...(msg.to ?? []), ...(msg.cc ?? [])];
}

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

	async _loadRosterNames() {
		const path = join(this.teamDir, 'members.json');
		try {
			const raw = await readFile(path, 'utf-8');
			const data = JSON.parse(raw);
			if (!Array.isArray(data.members)) return null;
			return data.members.map((m) => m?.name).filter((n) => typeof n === 'string' && n.length > 0);
		} catch {
			return null;
		}
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

	async _writeMailbox(member, kind, items) {
		const path = this._mailboxPath(member, kind);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify({ items }, null, '\t')}\n`, 'utf-8');
	}

	async _appendToMailbox(member, kind, id) {
		const items = await this._readMailbox(member, kind);
		if (!items.includes(id)) {
			items.push(id);
			await this._writeMailbox(member, kind, items);
		}
	}

	async _removeFromMailbox(member, kind, id) {
		const items = await this._readMailbox(member, kind);
		const idx = items.indexOf(id);
		if (idx === -1) return false;
		items.splice(idx, 1);
		await this._writeMailbox(member, kind, items);
		return true;
	}

	// ─── Core operations ───────────────────────────────────────────────────────

	async hasMessages(member) {
		const summaries = await this.listInbox(member);
		return summaries.length > 0;
	}

	async sendMessage({ from, to, cc, subject, body, replyTo, projectCode }) {
		if (!from) throw new Error('sendMessage: from is required');
		if (!Array.isArray(to) || to.length === 0) throw new Error('sendMessage: to is required');
		if (body == null) throw new Error('sendMessage: body is required');

		await this._validateParties('sendMessage', from, to, cc);

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
			body,
		});
		await writeFile(this._messagePath(id), content, 'utf-8');

		const recipients = [...to, ...(cc ?? [])];
		for (const recipient of recipients) {
			await this._appendToMailbox(recipient, 'inbox', id);
		}
		await this._appendToMailbox(from, 'sent', id);

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
	async supersedeMessage({ from, supersedes, to, cc, subject, body, projectCode, replyTo }) {
		if (!from) throw new Error('supersedeMessage: from is required');
		if (!Array.isArray(supersedes) || supersedes.length === 0) {
			throw new Error('supersedeMessage: supersedes must list at least one prior message id');
		}
		if (!Array.isArray(to) || to.length === 0) throw new Error('supersedeMessage: to is required');
		if (body == null) throw new Error('supersedeMessage: body is required');

		await this._validateParties('supersedeMessage', from, to, cc);

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
		for (const recipient of [...to, ...(cc ?? [])]) {
			await this._appendToMailbox(recipient, 'inbox', id);
		}
		await this._appendToMailbox(from, 'sent', id);

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
		const inbox = await this._readMailbox(member, 'inbox');
		const archives = await this._readMailbox(member, 'archives');

		const idx = inbox.indexOf(id);
		if (idx === -1) {
			if (archives.includes(id)) return; // already archived, no-op
			throw new Error(`archiveMessage: ${id} is not in ${member}'s inbox`);
		}
		inbox.splice(idx, 1);
		if (!archives.includes(id)) archives.push(id);

		await this._writeMailbox(member, 'inbox', inbox);
		await this._writeMailbox(member, 'archives', archives);
	}

	async unarchiveMessage(member, id) {
		const inbox = await this._readMailbox(member, 'inbox');
		const archives = await this._readMailbox(member, 'archives');

		const idx = archives.indexOf(id);
		if (idx === -1) {
			if (inbox.includes(id)) return;
			throw new Error(`unarchiveMessage: ${id} is not in ${member}'s archives`);
		}
		archives.splice(idx, 1);
		if (!inbox.includes(id)) inbox.push(id);

		await this._writeMailbox(member, 'inbox', inbox);
		await this._writeMailbox(member, 'archives', archives);
	}

	/**
	 * Delete a message from a member's inbox without archiving it.
	 * Used by the UI for explicit "discard" actions.
	 */
	async deleteInboxMessage(member, id) {
		const inbox = await this._readMailbox(member, 'inbox');
		const idx = inbox.indexOf(id);
		if (idx === -1) return;
		inbox.splice(idx, 1);
		await this._writeMailbox(member, 'inbox', inbox);
	}

	async deleteArchivedMessage(member, id) {
		const archives = await this._readMailbox(member, 'archives');
		const idx = archives.indexOf(id);
		if (idx === -1) return;
		archives.splice(idx, 1);
		await this._writeMailbox(member, 'archives', archives);
	}
}
