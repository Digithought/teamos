import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
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
		return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
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
	if (msg.cc && msg.cc.length) lines.push(`cc: [${msg.cc.join(', ')}]`);
	lines.push(`subject: ${msg.subject ?? ''}`);
	lines.push(`sentAt: ${msg.sentAt}`);
	if (msg.replyTo) lines.push(`replyTo: ${msg.replyTo}`);
	if (msg.projectCode) lines.push(`projectCode: ${msg.projectCode}`);
	lines.push('---', '', (msg.body ?? '').trimEnd(), '');
	return lines.join('\n');
}

function normalizeMessage(metadata, body) {
	return {
		id: typeof metadata.id === 'string' ? metadata.id : '',
		from: typeof metadata.from === 'string' ? metadata.from : 'unknown',
		to: Array.isArray(metadata.to) ? metadata.to : (metadata.to ? [metadata.to] : []),
		cc: Array.isArray(metadata.cc) ? metadata.cc : (metadata.cc ? [metadata.cc] : []),
		subject: typeof metadata.subject === 'string' ? metadata.subject : '',
		sentAt: typeof metadata.sentAt === 'string' ? metadata.sentAt : '',
		replyTo: typeof metadata.replyTo === 'string' && metadata.replyTo ? metadata.replyTo : undefined,
		projectCode: typeof metadata.projectCode === 'string' && metadata.projectCode ? metadata.projectCode : undefined,
		body,
	};
}

function stripReplyPrefix(subject) {
	return (subject ?? '').replace(/^(re:\s*)+/i, '').trim();
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
		await writeFile(path, JSON.stringify({ items }, null, '\t') + '\n', 'utf-8');
	}

	async _appendToMailbox(member, kind, id) {
		const items = await this._readMailbox(member, kind);
		if (!items.includes(id)) {
			items.push(id);
			await this._writeMailbox(member, kind, items);
		}
	}

	// ─── Core operations ───────────────────────────────────────────────────────

	async hasMessages(member) {
		const items = await this._readMailbox(member, 'inbox');
		return items.length > 0;
	}

	async sendMessage({ from, to, cc, subject, body, replyTo, projectCode }) {
		if (!from) throw new Error('sendMessage: from is required');
		if (!Array.isArray(to) || to.length === 0) throw new Error('sendMessage: to is required');
		if (body == null) throw new Error('sendMessage: body is required');

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
			id, from, to, cc, subject: derivedSubject, sentAt, replyTo, projectCode, body,
		});
		await writeFile(this._messagePath(id), content, 'utf-8');

		const recipients = [...to, ...(cc ?? [])];
		for (const recipient of recipients) {
			await this._appendToMailbox(recipient, 'inbox', id);
		}
		await this._appendToMailbox(from, 'sent', id);

		return { id, sentAt };
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
			});
		}
		entries.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
		return entries;
	}

	async listInbox(member) {
		const ids = await this._readMailbox(member, 'inbox');
		return this._summariesFromIds(ids);
	}

	async listSent(member) {
		const ids = await this._readMailbox(member, 'sent');
		return this._summariesFromIds(ids);
	}

	async listArchives(member) {
		const ids = await this._readMailbox(member, 'archives');
		return this._summariesFromIds(ids);
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
