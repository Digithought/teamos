import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/**
 * File-based schedule adapter.
 *
 * Implements the per-member schedule protocol described in teamos/docs/schedule.md:
 *   - One file per member at team/members/<name>/schedule.json
 *   - Opaque ids shaped `<isoTimestamp>-<4charRand>` (matches message / todo ids)
 *   - Recurrence advancement and one-time event cleanup happen in
 *     `acknowledgeDue`, never in agent-facing tools
 *
 * Migration: legacy files may contain events without `id` and/or with the old
 * `recurring: true` flag alongside `recurrence`. Every read normalizes both.
 * Any backfill is persisted so subsequent readers see a canonical form.
 */

const FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);

function makeEventId() {
	const iso = new Date().toISOString().replace(/:/g, '-');
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
	return `${iso}-${rand}`;
}

function isValidIsoTime(value) {
	if (typeof value !== 'string' || !value) return false;
	const d = new Date(value);
	return !isNaN(d.getTime());
}

function normalizeRecurrence(rec) {
	if (!rec || typeof rec !== 'object') return undefined;
	if (!FREQUENCIES.has(rec.frequency)) return undefined;
	const interval = Number(rec.interval);
	if (!Number.isInteger(interval) || interval < 1) return undefined;
	const out = { frequency: rec.frequency, interval };
	if (typeof rec.endDate === 'string' && isValidIsoTime(rec.endDate)) {
		out.endDate = rec.endDate;
	}
	return out;
}

/**
 * Compute the next occurrence of a recurring event strictly after `after`.
 * Used both for acknowledging a due event and for initial placement.
 */
export function nextOccurrence(base, recurrence, after) {
	const { frequency, interval = 1 } = recurrence;
	const baseDate = base instanceof Date ? base : new Date(base);
	const afterDate = after instanceof Date ? after : new Date(after);

	if (frequency === 'daily') {
		const ms = interval * 24 * 60 * 60 * 1000;
		const diff = afterDate.getTime() - baseDate.getTime();
		const periods = Math.max(1, Math.ceil((diff + 1) / ms));
		return new Date(baseDate.getTime() + periods * ms);
	}
	if (frequency === 'weekly') {
		const ms = interval * 7 * 24 * 60 * 60 * 1000;
		const diff = afterDate.getTime() - baseDate.getTime();
		const periods = Math.max(1, Math.ceil((diff + 1) / ms));
		return new Date(baseDate.getTime() + periods * ms);
	}
	if (frequency === 'monthly') {
		let d = new Date(baseDate);
		while (d <= afterDate) {
			d = new Date(d);
			d.setUTCMonth(d.getUTCMonth() + interval);
		}
		return d;
	}
	return new Date(baseDate.getTime() + interval * 24 * 60 * 60 * 1000);
}

export class FileScheduleAdapter {
	constructor(teamDir) {
		this.teamDir = teamDir;
	}

	_schedulePath(member) {
		return join(this.teamDir, 'members', member, 'schedule.json');
	}

	async _readRaw(member) {
		try {
			const raw = await readFile(this._schedulePath(member), 'utf-8');
			const data = JSON.parse(raw);
			return Array.isArray(data.events) ? data.events : [];
		} catch {
			return [];
		}
	}

	async _writeEvents(member, events) {
		const path = this._schedulePath(member);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify({ events }, null, '\t') + '\n', 'utf-8');
	}

	/**
	 * Normalize events: assign ids to legacy items, strip the old `recurring`
	 * flag, drop invalid entries. Persists the file if anything changed so
	 * subsequent calls see a canonical representation.
	 */
	async _loadNormalized(member) {
		const raw = await this._readRaw(member);
		let mutated = false;
		const events = [];
		for (const entry of raw) {
			if (!entry || typeof entry !== 'object') {
				mutated = true;
				continue;
			}
			const normalized = {};
			// Legacy entries may lack ids — allocate one.
			if (typeof entry.id === 'string' && entry.id) {
				normalized.id = entry.id;
			} else {
				normalized.id = makeEventId();
				mutated = true;
			}
			normalized.title = typeof entry.title === 'string' ? entry.title : '';
			if (typeof entry.description === 'string' && entry.description) {
				normalized.description = entry.description;
			}
			if (!isValidIsoTime(entry.time)) {
				// Can't recover an event without a valid time.
				mutated = true;
				continue;
			}
			normalized.time = new Date(entry.time).toISOString();
			if (normalized.time !== entry.time) mutated = true;

			const recurrence = normalizeRecurrence(entry.recurrence);
			if (recurrence) normalized.recurrence = recurrence;
			else if (entry.recurrence) mutated = true;

			// Legacy `recurring: true` flag — presence of `recurrence` is now the signal.
			if ('recurring' in entry) mutated = true;

			if (typeof entry.projectCode === 'string' && entry.projectCode) {
				normalized.projectCode = entry.projectCode;
			}
			events.push(normalized);
		}
		if (mutated) await this._writeEvents(member, events);
		return events;
	}

	/**
	 * Return events sorted by `time` ascending, each tagged with an `isDue`
	 * boolean computed against `now` (defaults to current time).
	 */
	async listEvents(member, now = new Date()) {
		const events = await this._loadNormalized(member);
		events.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
		return events.map(e => ({ ...e, isDue: new Date(e.time) <= now }));
	}

	async addEvent(member, input) {
		if (!input || typeof input.title !== 'string' || !input.title.trim()) {
			throw new Error('add_event: title is required');
		}
		if (!isValidIsoTime(input.time)) {
			throw new Error('add_event: time must be an ISO-8601 timestamp');
		}
		const recurrence = input.recurrence === undefined
			? undefined
			: normalizeRecurrence(input.recurrence);
		if (input.recurrence && !recurrence) {
			throw new Error('add_event: recurrence must have a valid frequency (daily|weekly|monthly) and positive integer interval');
		}

		const events = await this._loadNormalized(member);
		const event = {
			id: makeEventId(),
			title: input.title.trim(),
			time: new Date(input.time).toISOString(),
		};
		if (typeof input.description === 'string' && input.description) {
			event.description = input.description;
		}
		if (recurrence) event.recurrence = recurrence;
		if (typeof input.projectCode === 'string' && input.projectCode) {
			event.projectCode = input.projectCode;
		}
		events.push(event);
		await this._writeEvents(member, events);
		return { id: event.id };
	}

	async updateEvent(member, id, patch) {
		if (!id) throw new Error('update_event: id is required');
		if (!patch || typeof patch !== 'object') {
			throw new Error('update_event: patch is required');
		}
		const events = await this._loadNormalized(member);
		const idx = events.findIndex(e => e.id === id);
		if (idx === -1) throw new Error(`update_event: ${id} is not in ${member}'s schedule`);

		const next = { ...events[idx] };

		if (patch.title !== undefined) {
			if (typeof patch.title !== 'string' || !patch.title.trim()) {
				throw new Error('update_event: title cannot be empty');
			}
			next.title = patch.title.trim();
		}
		if (patch.description !== undefined) {
			if (patch.description === null || patch.description === '') delete next.description;
			else next.description = String(patch.description);
		}
		if (patch.time !== undefined) {
			if (!isValidIsoTime(patch.time)) {
				throw new Error('update_event: time must be an ISO-8601 timestamp');
			}
			next.time = new Date(patch.time).toISOString();
		}
		if (patch.recurrence !== undefined) {
			if (patch.recurrence === null) {
				delete next.recurrence;
			} else {
				const rec = normalizeRecurrence(patch.recurrence);
				if (!rec) {
					throw new Error('update_event: recurrence must have a valid frequency and positive integer interval, or null to clear');
				}
				next.recurrence = rec;
			}
		}
		if (patch.projectCode !== undefined) {
			if (patch.projectCode === null || patch.projectCode === '') delete next.projectCode;
			else next.projectCode = String(patch.projectCode);
		}

		events[idx] = next;
		await this._writeEvents(member, events);
	}

	async removeEvent(member, id) {
		if (!id) throw new Error('remove_event: id is required');
		const events = await this._loadNormalized(member);
		const idx = events.findIndex(e => e.id === id);
		if (idx === -1) throw new Error(`remove_event: ${id} is not in ${member}'s schedule`);
		events.splice(idx, 1);
		await this._writeEvents(member, events);
	}

	async hasDueEvents(member, now = new Date()) {
		const events = await this._loadNormalized(member);
		return events.some(e => new Date(e.time) <= now);
	}

	/**
	 * For every event that was due at `cycleStartTime`:
	 *   - recurring → advance `time` to the next occurrence after
	 *     `cycleStartTime` (or remove if past `endDate`)
	 *   - one-time  → remove entirely
	 *
	 * Called by the runner after a successful cycle. Idempotent: if called
	 * twice for the same cycleStartTime it still leaves the schedule in the
	 * right state.
	 */
	async acknowledgeDue(member, cycleStartTime) {
		const cutoff = cycleStartTime instanceof Date ? cycleStartTime : new Date(cycleStartTime);
		const events = await this._loadNormalized(member);
		let mutated = false;
		const next = [];
		for (const event of events) {
			const eventTime = new Date(event.time);
			if (eventTime > cutoff) {
				next.push(event);
				continue;
			}
			if (event.recurrence) {
				const advanced = nextOccurrence(eventTime, event.recurrence, cutoff);
				if (event.recurrence.endDate && advanced > new Date(event.recurrence.endDate)) {
					mutated = true;
					continue;
				}
				next.push({ ...event, time: advanced.toISOString() });
				mutated = true;
			} else {
				mutated = true;
			}
		}
		if (mutated) await this._writeEvents(member, next);
	}

	/**
	 * Check whether an event with the given title already exists. Used by the
	 * runner to inject system events (Daily Check-in, Weekly Self-Assessment)
	 * without creating duplicates.
	 */
	async hasEventWithTitle(member, title) {
		const events = await this._loadNormalized(member);
		return events.some(e => e.title === title);
	}
}
