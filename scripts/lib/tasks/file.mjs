import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { PRIORITY_ORDER } from '../scheduler.mjs';

/**
 * File-based tasks adapter.
 *
 * Implements the per-member todo protocol described in teamos/docs/tasks.md:
 *   - One file per member at team/members/<name>/todo.json
 *   - Stores only open items (completion removes the item)
 *   - Opaque ids shaped `<isoTimestamp>-<4charRand>` (matches message ids)
 *
 * Agents never touch this file directly — they go through the MCP tools
 * wired up in scripts/lib/messaging/mcp-server.mjs. The runner reads it
 * via `listTodos` when building the cycle prompt.
 */

function makeTodoId() {
	const iso = new Date().toISOString().replace(/:/g, '-');
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
	return `${iso}-${rand}`;
}

function isValidPriority(p) {
	return PRIORITY_ORDER.includes(p);
}

function sanitizeItem(item) {
	const out = {
		id: typeof item.id === 'string' && item.id ? item.id : makeTodoId(),
		title: typeof item.title === 'string' ? item.title : '',
		priority: isValidPriority(item.priority) ? item.priority : 'later',
	};
	if (typeof item.description === 'string' && item.description) out.description = item.description;
	if (item.status === 'blocked') out.status = 'blocked';
	if (typeof item.notes === 'string' && item.notes) out.notes = item.notes;
	if (typeof item.projectCode === 'string' && item.projectCode) out.projectCode = item.projectCode;
	return out;
}

export class FileTasksAdapter {
	constructor(teamDir) {
		this.teamDir = teamDir;
	}

	_todoPath(member) {
		return join(this.teamDir, 'members', member, 'todo.json');
	}

	async _readItems(member) {
		try {
			const raw = await readFile(this._todoPath(member), 'utf-8');
			const data = JSON.parse(raw);
			return Array.isArray(data.items) ? data.items : [];
		} catch {
			return [];
		}
	}

	async _writeItems(member, items) {
		const path = this._todoPath(member);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify({ items }, null, '\t') + '\n', 'utf-8');
	}

	/**
	 * Load items and normalize them: assign ids to any legacy items that
	 * lack one. If any ids were backfilled, persist the file so subsequent
	 * calls see the same ids.
	 */
	async _loadNormalized(member) {
		const raw = await this._readItems(member);
		let mutated = false;
		const items = raw.map((item) => {
			if (typeof item.id === 'string' && item.id) return item;
			mutated = true;
			return { id: makeTodoId(), ...item };
		});
		if (mutated) await this._writeItems(member, items);
		return items;
	}

	async listTodos(member) {
		const items = await this._loadNormalized(member);
		// Sort by priority (pressing → later); blocked items after actionable
		// within each priority; insertion order is the final tiebreaker.
		const indexed = items.map((item, idx) => ({ item, idx }));
		indexed.sort((a, b) => {
			const pa = PRIORITY_ORDER.indexOf(a.item.priority);
			const pb = PRIORITY_ORDER.indexOf(b.item.priority);
			if (pa !== pb) return pa - pb;
			const ba = a.item.status === 'blocked' ? 1 : 0;
			const bb = b.item.status === 'blocked' ? 1 : 0;
			if (ba !== bb) return ba - bb;
			return a.idx - b.idx;
		});
		return indexed.map((e) => e.item);
	}

	async addTodo(member, input) {
		if (!input || typeof input.title !== 'string' || !input.title.trim()) {
			throw new Error('add_todo: title is required');
		}
		if (!isValidPriority(input.priority)) {
			throw new Error(`add_todo: priority must be one of ${PRIORITY_ORDER.join(', ')}`);
		}
		const items = await this._loadNormalized(member);
		const item = sanitizeItem({
			id: makeTodoId(),
			title: input.title.trim(),
			priority: input.priority,
			description: input.description,
			notes: input.notes,
			projectCode: input.projectCode,
			status: input.status === 'blocked' ? 'blocked' : undefined,
		});
		items.push(item);
		await this._writeItems(member, items);
		return { id: item.id };
	}

	async updateTodo(member, id, patch) {
		if (!id) throw new Error('update_todo: id is required');
		const items = await this._loadNormalized(member);
		const idx = items.findIndex((i) => i.id === id);
		if (idx === -1) throw new Error(`update_todo: ${id} is not in ${member}'s todo list`);

		const current = items[idx];
		const next = { ...current };

		if (patch.title !== undefined) {
			if (typeof patch.title !== 'string' || !patch.title.trim()) {
				throw new Error('update_todo: title cannot be empty');
			}
			next.title = patch.title.trim();
		}
		if (patch.description !== undefined) {
			if (patch.description === null || patch.description === '') delete next.description;
			else next.description = String(patch.description);
		}
		if (patch.priority !== undefined) {
			if (!isValidPriority(patch.priority)) {
				throw new Error(`update_todo: priority must be one of ${PRIORITY_ORDER.join(', ')}`);
			}
			next.priority = patch.priority;
		}
		if (patch.notes !== undefined) {
			if (patch.notes === null || patch.notes === '') delete next.notes;
			else next.notes = String(patch.notes);
		}
		if (patch.projectCode !== undefined) {
			if (patch.projectCode === null || patch.projectCode === '') delete next.projectCode;
			else next.projectCode = String(patch.projectCode);
		}
		if (patch.status !== undefined) {
			if (patch.status === null) delete next.status;
			else if (patch.status === 'blocked') next.status = 'blocked';
			else throw new Error('update_todo: status must be "blocked" or null');
		}

		items[idx] = next;
		await this._writeItems(member, items);
	}

	async completeTodo(member, id) {
		if (!id) throw new Error('complete_todo: id is required');
		const items = await this._loadNormalized(member);
		const idx = items.findIndex((i) => i.id === id);
		if (idx === -1) throw new Error(`complete_todo: ${id} is not in ${member}'s todo list`);
		items.splice(idx, 1);
		await this._writeItems(member, items);
	}

	async hasActionableTodos(member, priority) {
		const items = await this._readItems(member);
		const ceiling = PRIORITY_ORDER.indexOf(priority);
		if (ceiling < 0) return false;
		return items.some((i) => i.status !== 'blocked' && PRIORITY_ORDER.indexOf(i.priority) <= ceiling);
	}
}
