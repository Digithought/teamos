import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIORITY_ORDER } from './scheduler.mjs';
import { pathExists } from './util.mjs';

// ─── Member discovery ──────────────────────────────────────────────────────────

export async function loadMembers(teamDir) {
	const content = await readFile(join(teamDir, 'members.json'), 'utf-8');
	const manifest = JSON.parse(content);
	return manifest.members.filter((m) => m.active && m.type === 'ai');
}

// ─── Work detection ────────────────────────────────────────────────────────────

/**
 * Check if a member has work at the given priority level.
 *
 * Inbox work is detected in O(1) by reading inbox.json directly — no master
 * store lookups are needed for "does this member have a message?".
 *
 * @param {Object} [adapters] — the wake-signal adapters: `messaging`, `tasks`,
 *   `schedule`, `triggers`, `watches`. Each is optional; `adapters.tasks`, when
 *   provided, checks todos through the adapter contract (`hasActionableTodos`)
 *   instead of reading todo.json directly.
 */
export async function memberHasWork(memberName, priority, teamDir, adapters = {}) {
	const memberDir = join(teamDir, 'members', memberName);

	// Check inbox.json for pending messages
	if (adapters.messaging) {
		if (await adapters.messaging.hasMessages(memberName)) return true;
	} else {
		const inboxJson = join(memberDir, 'inbox.json');
		if (await pathExists(inboxJson)) {
			try {
				const data = JSON.parse(await readFile(inboxJson, 'utf-8'));
				if (Array.isArray(data.items) && data.items.length > 0) return true;
			} catch {
				/* ignore */
			}
		}
	}

	// Check todos at this priority or higher
	if (adapters.tasks) {
		if (await adapters.tasks.hasActionableTodos(memberName, priority)) return true;
	} else {
		const todoPath = join(memberDir, 'todo.json');
		if (await pathExists(todoPath)) {
			try {
				const todos = JSON.parse(await readFile(todoPath, 'utf-8'));
				const priorityIdx = PRIORITY_ORDER.indexOf(priority);
				if (todos.items.some((t) => t.status !== 'blocked' && PRIORITY_ORDER.indexOf(t.priority) <= priorityIdx))
					return true;
			} catch {
				/* ignore */
			}
		}
	}

	// Check schedule for due events — always via adapter so the contract stays
	// stable across file / calendar backends.
	if (adapters.schedule) {
		if (await adapters.schedule.hasDueEvents(memberName, new Date())) return true;
	}

	// Check commit triggers — new commits matching a member's subscriptions at
	// this priority or higher count as work.
	if (adapters.triggers) {
		if (await adapters.triggers.hasPendingMatches(memberName, priority)) return true;
	}

	// Check watches — a probe whose result changed since the member was last
	// woken counts as work at the watch's priority. Probes are not run here;
	// the runner polls them between cycles.
	if (adapters.watches) {
		if (await adapters.watches.hasPendingObservations(memberName, priority)) return true;
	}

	return false;
}

export async function getMembersWithWork(members, priority, teamDir, adapters = {}) {
	const results = [];
	for (const member of members) {
		if (await memberHasWork(member.name, priority, teamDir, adapters)) {
			results.push(member);
		}
	}
	return results;
}

// ─── System-injected schedule events ──────────────────────────────────────────

const SELF_ASSESSMENT_TITLE = 'Weekly Self-Assessment';
const DAILY_CHECKIN_TITLE = 'Daily Check-in';

function nextFriday(from = new Date()) {
	const d = new Date(from);
	d.setUTCHours(18, 0, 0, 0);
	const day = d.getUTCDay();
	const daysUntilFri = (5 - day + 7) % 7 || 7;
	d.setUTCDate(d.getUTCDate() + daysUntilFri);
	return d;
}

function nextMorning(from = new Date()) {
	const d = new Date(from);
	d.setUTCHours(9, 0, 0, 0);
	d.setUTCDate(d.getUTCDate() + 1);
	return d;
}

export async function ensureSelfAssessmentEvents(members, scheduleAdapter) {
	let added = 0;
	for (const member of members) {
		if (await scheduleAdapter.hasEventWithTitle(member.name, SELF_ASSESSMENT_TITLE)) continue;
		// Skip the first occurrence so a freshly-added member doesn't immediately
		// think it needs to self-assess on its first cycle.
		const first = nextFriday(new Date());
		first.setUTCDate(first.getUTCDate() + 7);
		await scheduleAdapter.addEvent(member.name, {
			title: SELF_ASSESSMENT_TITLE,
			description: 'Conduct a weekly self-assessment following the rules in teamos/agent-rules/self-assessment.md.',
			time: first.toISOString(),
			recurrence: { frequency: 'weekly', interval: 1 },
		});
		added++;
	}
	if (added > 0) {
		console.log(`[runner] Added self-assessment schedule event to ${added} member(s).`);
	}
}

export async function ensureDailyCheckinEvents(members, scheduleAdapter) {
	let added = 0;
	for (const member of members) {
		if (await scheduleAdapter.hasEventWithTitle(member.name, DAILY_CHECKIN_TITLE)) continue;
		// Skip the first occurrence so a freshly-added member doesn't immediately
		// think it needs to check in on its first cycle.
		const first = nextMorning(new Date());
		first.setUTCDate(first.getUTCDate() + 1);
		await scheduleAdapter.addEvent(member.name, {
			title: DAILY_CHECKIN_TITLE,
			description: 'Daily check-in following the rules in teamos/agent-rules/daily-checkin.md.',
			time: first.toISOString(),
			recurrence: { frequency: 'daily', interval: 1 },
		});
		added++;
	}
	if (added > 0) {
		console.log(`[runner] Added daily check-in schedule event to ${added} member(s).`);
	}
}
