import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from './util.mjs';
import { PRIORITY_ORDER } from './scheduler.mjs';

// ─── Member discovery ──────────────────────────────────────────────────────────

export async function loadMembers(teamDir) {
	const content = await readFile(join(teamDir, 'members.json'), 'utf-8');
	const manifest = JSON.parse(content);
	return manifest.members
		.filter(m => m.active && m.type === 'ai');
}

// ─── Work detection ────────────────────────────────────────────────────────────

/**
 * Determine if a schedule event is currently due.
 */
export function isEventDue(event, now) {
	return new Date(event.time) <= now;
}

/**
 * Compute the next occurrence of a recurring event after `after`.
 */
export function nextOccurrence(base, recurrence, after) {
	const { frequency, interval = 1 } = recurrence;

	if (frequency === 'daily') {
		const ms = interval * 24 * 60 * 60 * 1000;
		const periods = Math.ceil((after - base) / ms);
		return new Date(base.getTime() + Math.max(1, periods) * ms);
	}

	if (frequency === 'weekly') {
		const ms = interval * 7 * 24 * 60 * 60 * 1000;
		const periods = Math.ceil((after - base) / ms);
		return new Date(base.getTime() + Math.max(1, periods) * ms);
	}

	if (frequency === 'monthly') {
		let d = new Date(base);
		while (d <= after) {
			d = new Date(d);
			d.setMonth(d.getMonth() + interval);
		}
		return d;
	}

	return new Date(base.getTime() + interval * 24 * 60 * 60 * 1000);
}

/**
 * Check if a member has work at the given priority level.
 * Uses messagingAdapter.hasMessages() instead of directly scanning inbox/.
 * Falls back to direct inbox scanning if no messaging adapter is provided.
 */
export async function memberHasWork(memberName, priority, teamDir, messagingAdapter) {
	const memberDir = join(teamDir, 'members', memberName);

	// Check inbox for messages via adapter
	if (messagingAdapter) {
		if (await messagingAdapter.hasMessages(memberName)) return true;
	} else {
		// Fallback: direct inbox scanning (backwards compat)
		const inboxDir = join(memberDir, 'inbox');
		if (await pathExists(inboxDir)) {
			try {
				const files = await readdir(inboxDir);
				if (files.some(f => f.endsWith('.md'))) return true;
			} catch { /* ignore */ }
		}
	}

	// Check todos at this priority or higher
	const todoPath = join(memberDir, 'todo.json');
	if (await pathExists(todoPath)) {
		try {
			const todos = JSON.parse(await readFile(todoPath, 'utf-8'));
			const priorityIdx = PRIORITY_ORDER.indexOf(priority);
			if (todos.items.some(t => t.status !== 'blocked' && PRIORITY_ORDER.indexOf(t.priority) <= priorityIdx)) return true;
		} catch { /* ignore */ }
	}

	// Check schedule for due events
	const schedulePath = join(memberDir, 'schedule.json');
	if (await pathExists(schedulePath)) {
		try {
			const schedule = JSON.parse(await readFile(schedulePath, 'utf-8'));
			const now = new Date();
			if (schedule.events.some(e => isEventDue(e, now))) return true;
		} catch { /* ignore */ }
	}

	return false;
}

/**
 * After a member's cycle, advance any due recurring events to their next
 * occurrence so they don't re-trigger until the next period.
 */
export async function advanceRecurringEvents(memberName, teamDir) {
	const schedulePath = join(teamDir, 'members', memberName, 'schedule.json');
	try {
		const raw = await readFile(schedulePath, 'utf-8');
		const schedule = JSON.parse(raw);
		const now = new Date();
		let changed = false;
		for (const event of (schedule.events ?? [])) {
			if (event.recurring && event.recurrence && new Date(event.time) <= now) {
				event.time = nextOccurrence(new Date(event.time), event.recurrence, now).toISOString();
				changed = true;
			}
		}
		if (changed) {
			await writeFile(schedulePath, JSON.stringify(schedule, null, '\t') + '\n', 'utf-8');
		}
	} catch { /* missing or invalid schedule is fine */ }
}

export async function getMembersWithWork(members, priority, teamDir, messagingAdapter) {
	const results = [];
	for (const member of members) {
		if (await memberHasWork(member.name, priority, teamDir, messagingAdapter)) {
			results.push(member);
		}
	}
	return results;
}

// ─── Self-assessment schedule injection ─────────────────────────────────────────

const SELF_ASSESSMENT_TITLE = 'Weekly Self-Assessment';

function nextFriday(from = new Date()) {
	const d = new Date(from);
	d.setUTCHours(18, 0, 0, 0);
	const day = d.getUTCDay();
	const daysUntilFri = (5 - day + 7) % 7 || 7;
	d.setUTCDate(d.getUTCDate() + daysUntilFri);
	return d;
}

function buildSelfAssessmentEvent(fromDate) {
	return {
		title: SELF_ASSESSMENT_TITLE,
		description:
			'Conduct a weekly self-assessment following the rules in teamos/agent-rules/self-assessment.md. ',
		time: nextFriday(fromDate).toISOString(),
		recurring: true,
		recurrence: {
			frequency: 'weekly',
			interval: 1,
		},
	};
}

export async function ensureSelfAssessmentEvents(members, teamDir) {
	let added = 0;
	for (const member of members) {
		const schedulePath = join(teamDir, 'members', member.name, 'schedule.json');
		let schedule;
		try {
			schedule = JSON.parse(await readFile(schedulePath, 'utf-8'));
		} catch {
			schedule = { events: [] };
		}

		const hasAssessment = schedule.events.some(
			e => e.title === SELF_ASSESSMENT_TITLE,
		);
		if (!hasAssessment) {
			schedule.events.push(buildSelfAssessmentEvent(new Date()));
			await writeFile(schedulePath, JSON.stringify(schedule, null, '\t') + '\n', 'utf-8');
			added++;
		}
	}
	if (added > 0) {
		console.log(`[runner] Added self-assessment schedule event to ${added} member(s).`);
	}
}

// ─── Daily check-in schedule injection ────────────────────────────────────────

const DAILY_CHECKIN_TITLE = 'Daily Check-in';

function nextMorning(from = new Date()) {
	const d = new Date(from);
	d.setUTCHours(9, 0, 0, 0);
	d.setUTCDate(d.getUTCDate() + 1);
	return d;
}

function buildDailyCheckinEvent(fromDate) {
	return {
		title: DAILY_CHECKIN_TITLE,
		description:
			'Daily check-in following the rules in teamos/agent-rules/daily-checkin.md.',
		time: nextMorning(fromDate).toISOString(),
		recurring: true,
		recurrence: {
			frequency: 'daily',
			interval: 1,
		},
	};
}

export async function ensureDailyCheckinEvents(members, teamDir) {
	let added = 0;
	for (const member of members) {
		const schedulePath = join(teamDir, 'members', member.name, 'schedule.json');
		let schedule;
		try {
			schedule = JSON.parse(await readFile(schedulePath, 'utf-8'));
		} catch {
			schedule = { events: [] };
		}

		const hasCheckin = schedule.events.some(
			e => e.title === DAILY_CHECKIN_TITLE,
		);
		if (!hasCheckin) {
			schedule.events.push(buildDailyCheckinEvent(new Date()));
			await writeFile(schedulePath, JSON.stringify(schedule, null, '\t') + '\n', 'utf-8');
			added++;
		}
	}
	if (added > 0) {
		console.log(`[runner] Added daily check-in schedule event to ${added} member(s).`);
	}
}
