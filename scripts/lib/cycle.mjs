import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agents/index.mjs';
import { PRIORITY_ORDER, normalizeVruntimes, pickNextPriority, rotateAfter } from './scheduler.mjs';
import {
	buildLogPath,
	buildToolsPromptSection,
	checkStop,
	formatTimestamp,
	readTextOrEmpty,
	waitWhilePaused,
} from './util.mjs';
import { getMembersWithWork } from './work-detection.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEAMOS_ROOT = join(__dirname, '..', '..');

const MAX_RUN_MS = 60 * 60 * 1000; // 1 hour hard stop (single-run mode only)
const BACKOFF_INITIAL_MS = 30 * 1000; // 30 seconds after first failure
const BACKOFF_MAX_MS = 30 * 60 * 1000; // cap at 30 minutes

// ─── Prompt building ───────────────────────────────────────────────────────────

function formatRecipients(to, cc) {
	const parts = [`To: ${(to ?? []).join(', ') || '(none)'}`];
	if (cc?.length) parts.push(`Cc: ${cc.join(', ')}`);
	return parts.join('  ');
}

function renderMessage(msg, { heading, headingLevel = '###' }) {
	const lines = [];
	lines.push(`${headingLevel} ${heading}`);
	lines.push('');
	lines.push(`**Id:** ${msg.id}`);
	lines.push(`**From:** ${msg.from}`);
	lines.push(formatRecipients(msg.to, msg.cc));
	lines.push(`**Subject:** ${msg.subject || '(no subject)'}`);
	lines.push(`**Sent:** ${msg.sentAt}`);
	if (msg.projectCode) lines.push(`**Project:** ${msg.projectCode}`);
	if (msg.replyTo) lines.push(`**In reply to:** ${msg.replyTo}`);
	lines.push('');
	lines.push(msg.body || '');
	return lines;
}

async function buildInboxSection(member, messagingAdapter) {
	const summaries = await messagingAdapter.listInbox(member);
	if (summaries.length === 0) {
		return ['', '## Inbox', '', 'No pending messages.', ''];
	}

	const out = ['', `## Inbox (${summaries.length})`, ''];
	for (const summary of summaries) {
		const msg = await messagingAdapter.readMessage(summary.id, { inlineParent: true }).catch(() => null);
		if (!msg) continue;

		out.push(...renderMessage(msg, { heading: msg.subject || summary.subject || '(no subject)' }));

		if (msg.parent) {
			out.push('');
			out.push('<details><summary>Previous message in thread</summary>');
			out.push('');
			out.push(...renderMessage(msg.parent, { heading: msg.parent.subject || '(no subject)', headingLevel: '####' }));
			out.push('');
			out.push('</details>');
		}
		out.push('', '---', '');
	}
	return out;
}

function formatTodoForPrompt(item) {
	const parts = [];
	parts.push(
		`- [${item.priority}]${item.status === 'blocked' ? ' [BLOCKED]' : ''} ${item.title}  \`(id: ${item.id})\``,
	);
	if (item.description) parts.push(`    ${item.description.replace(/\n/g, '\n    ')}`);
	if (item.projectCode) parts.push(`    project: ${item.projectCode}`);
	if (item.notes) parts.push(`    notes: ${item.notes.replace(/\n/g, '\n    ')}`);
	return parts.join('\n');
}

async function buildTodoSection(member, tasksAdapter) {
	if (!tasksAdapter) return '_(tasks adapter unavailable)_';
	const items = await tasksAdapter.listTodos(member).catch(() => []);
	if (items.length === 0) return '_No open todos._';
	return items.map(formatTodoForPrompt).join('\n');
}

function formatEventForPrompt(event) {
	const parts = [];
	const rec = event.recurrence
		? ` (${event.recurrence.frequency} ×${event.recurrence.interval}${event.recurrence.endDate ? `, until ${event.recurrence.endDate}` : ''})`
		: '';
	parts.push(`- **${event.title || '(untitled)'}** — ${event.time}${rec}  \`(id: ${event.id})\``);
	if (event.description) parts.push(`    ${event.description.replace(/\n/g, '\n    ')}`);
	if (event.projectCode) parts.push(`    project: ${event.projectCode}`);
	return parts.join('\n');
}

async function buildScheduleSections(member, scheduleAdapter) {
	if (!scheduleAdapter) {
		return {
			due: '_(schedule adapter unavailable)_',
			upcoming: '_(schedule adapter unavailable)_',
		};
	}
	const events = await scheduleAdapter.listEvents(member).catch(() => []);
	const due = events.filter((e) => e.isDue);
	const upcoming = events.filter((e) => !e.isDue);
	return {
		due: due.length === 0 ? '_No events due this cycle._' : due.map(formatEventForPrompt).join('\n'),
		upcoming: upcoming.length === 0 ? '_No upcoming events._' : upcoming.map(formatEventForPrompt).join('\n'),
	};
}

function formatCommitMatchForPrompt(match) {
	const lines = [];
	lines.push(`- \`${match.shortHash}\` **${match.subject}**  _by ${match.author}_  (priority: ${match.priority})`);
	lines.push(
		`    hash: ${match.hash}  matched triggers: ${match.matchedTriggerIds.join(', ')}` +
			`  — call \`clear_trigger_matches\` once reviewed, or it will keep reappearing`,
	);
	if (match.files.length > 0) {
		const shown = match.files.slice(0, 10);
		for (const f of shown) lines.push(`    - ${f}`);
		if (match.files.length > shown.length) {
			lines.push(`    - _…and ${match.files.length - shown.length} more_`);
		}
	}
	return lines.join('\n');
}

async function buildCommitTriggersSection(member, triggersAdapter) {
	if (!triggersAdapter) return null;
	const matches = await triggersAdapter.pendingMatches(member).catch(() => []);
	if (matches.length === 0) return null;
	return matches.map(formatCommitMatchForPrompt).join('\n');
}

function formatWatchObservationForPrompt(obs) {
	const lines = [];
	const label =
		obs.status === 'error'
			? 'PROBE ERROR'
			: obs.status === 'hit'
				? 'hit'
				: obs.status === 'clear'
					? 'cleared'
					: 'changed';
	const was = obs.previousStatus && obs.previousStatus !== obs.status ? `, was ${obs.previousStatus}` : '';
	lines.push(`- \`${obs.probe}\` **${label}**${obs.reason ? ` — ${obs.reason}` : ''}  \`(id: ${obs.watchId})\``);
	lines.push(
		`    priority: ${obs.priority}  observed: ${obs.observedAt}${obs.exitCode != null ? `  exit: ${obs.exitCode}` : ''}${was}`,
	);
	if (obs.error) lines.push(`    probe did not run: ${obs.error}`);
	const out = (obs.output ?? '').split('\n').filter((l) => l.trim());
	const shown = out.slice(0, 10);
	for (const l of shown) lines.push(`    ${l}`);
	if (out.length > shown.length) lines.push(`    _…and ${out.length - shown.length} more line(s)_`);
	return lines.join('\n');
}

async function buildWatchesSection(member, watchesAdapter) {
	if (!watchesAdapter) return null;
	const observations = await watchesAdapter.pendingObservations(member).catch(() => []);
	if (observations.length === 0) return null;
	return observations.map(formatWatchObservationForPrompt).join('\n');
}

export async function buildCyclePrompt(member, priority, teamDir, adapters = {}) {
	const memberDir = join(teamDir, 'members', member.name);
	const rulesFile = join(TEAMOS_ROOT, 'agent-rules', 'cycle.md');

	const [
		rules,
		orgDoc,
		memosDoc,
		projectsDoc,
		membersDoc,
		profile,
		state,
		todosText,
		scheduleSections,
		triggersSection,
		watchesSection,
	] = await Promise.all([
		readTextOrEmpty(rulesFile),
		readTextOrEmpty(join(teamDir, 'org.md')),
		readTextOrEmpty(join(teamDir, 'memos.json')),
		readTextOrEmpty(join(teamDir, 'projects.json')),
		readTextOrEmpty(join(teamDir, 'members.json')),
		readTextOrEmpty(join(memberDir, 'profile.md')),
		readTextOrEmpty(join(memberDir, 'state.md')),
		buildTodoSection(member.name, adapters.tasks),
		buildScheduleSections(member.name, adapters.schedule),
		buildCommitTriggersSection(member.name, adapters.triggers),
		buildWatchesSection(member.name, adapters.watches),
	]);

	const parts = [
		`# TeamOS Cycle: ${member.name} (${member.title})`,
		`# Priority: ${priority}`,
		`# Time: ${formatTimestamp()}`,
		'# Team directory: team/',
		`# Member directory: team/members/${member.name}/`,
		'',
		'## Organization',
		'',
		orgDoc,
		'',
		'## Memos',
		'',
		memosDoc,
		'',
		'## Projects',
		'',
		projectsDoc,
		'',
		'## Team Members',
		'',
		membersDoc,
		'',
		'---',
		'',
		`## Your Profile (${member.name})`,
		'',
		profile || '_No profile found._',
		'',
		'## Your Current State',
		'',
		state || '_No state file found._',
		'',
		'## Your TODOs',
		'',
		todosText,
		'',
		'## Due Events',
		'',
		scheduleSections.due,
		'',
		'## Upcoming Events',
		'',
		scheduleSections.upcoming,
	];

	if (triggersSection) {
		parts.push(
			'',
			'## Commit Triggers Fired',
			'',
			'New commits in the host repo matched your trigger subscriptions. Review them as part of this cycle.',
			'',
			triggersSection,
		);
	}

	if (watchesSection) {
		parts.push(
			'',
			'## Watches Fired',
			'',
			'A probe you watch changed state. These are host-side conditions — no message, todo, event or commit reports them. Handle them as part of this cycle; they are acknowledged only when this cycle succeeds.',
			'',
			watchesSection,
		);
	}

	const inboxSection = await buildInboxSection(member.name, adapters.messaging);
	parts.push(...inboxSection);

	parts.push(...buildToolsPromptSection('cycle'));

	parts.push(
		'',
		'## Cycle Rules',
		'',
		rules,
		'',
		'----',
		'',
		`Execute a cycle for **${member.name}** at priority level **${priority}**.`,
	);

	return parts.join('\n');
}

// ─── Cycle execution ───────────────────────────────────────────────────────────

export async function runCycle({
	membersWithWork,
	priority,
	cycleCount,
	opts,
	teamDir,
	logsDir,
	version,
	repoRoot,
	startTime,
	useTimeout,
	failureState,
	syncAdapter,
	adapters,
}) {
	let memberRuns = 0;
	let lastError = null;
	let stopped = false;

	for (const member of membersWithWork) {
		if (useTimeout && Date.now() - startTime >= MAX_RUN_MS) break;
		if (await checkStop(teamDir)) {
			stopped = true;
			break;
		}
		if ((await waitWhilePaused(teamDir)) === 'stop') {
			stopped = true;
			break;
		}

		// Exponential backoff after consecutive failures (e.g. network outage)
		if (failureState.consecutive > 0) {
			const delay = Math.min(BACKOFF_INITIAL_MS * 2 ** (failureState.consecutive - 1), BACKOFF_MAX_MS);
			console.log(
				`[runner] ${failureState.consecutive} consecutive failure(s) — backing off ${Math.round(delay / 1000)}s before next member.`,
			);
			await new Promise((r) => setTimeout(r, delay));
			if (await checkStop(teamDir)) {
				stopped = true;
				break;
			}
		}

		memberRuns++;
		const currentLog = buildLogPath(logsDir, member.name, priority);

		console.log(
			[
				`${'─'.repeat(72)}`,
				`  ${member.name} (${member.title})`,
				`  Priority: ${priority}  |  Cycle: ${cycleCount}`,
				`  Log: ${currentLog}`,
				`${'─'.repeat(72)}`,
			].join('\n'),
		);

		await writeFile(
			currentLog,
			[
				`Member: ${member.name} (${member.title})`,
				`Priority: ${priority}`,
				`Agent: ${opts.agent}`,
				`TeamOS: ${version}`,
				`Started: ${new Date().toISOString()}`,
				'═'.repeat(72),
				'',
			].join('\n'),
		);

		// Capture cycleStart before building the prompt so acknowledgeDue uses
		// the same "now" the agent saw — events that become due mid-cycle wait
		// for the next pass instead of being silently advanced.
		const cycleStart = new Date();
		const prompt = await buildCyclePrompt(member, priority, teamDir, adapters);
		const mcpContext =
			adapters.messaging || adapters.tasks || adapters.schedule || adapters.triggers || adapters.watches
				? {
						teamDir,
						memberName: member.name,
						messagingAdapterName: opts.messaging,
						tasksAdapterName: opts.tasks,
						scheduleAdapterName: opts.schedule,
						triggersAdapterName: opts.triggers,
						watchesAdapterName: opts.watches,
					}
				: undefined;
		const exitCode = await runAgent(opts.agent, prompt, repoRoot, currentLog, mcpContext);

		if (exitCode !== 0) {
			failureState.consecutive++;
			lastError = `Agent exited with code ${exitCode} for member: ${member.name}`;
			console.error(`\n${lastError}`);
			console.error(`Log: ${currentLog}`);
		} else {
			failureState.consecutive = 0;
			// Only acknowledge on success — on failure, due events fire again
			// next cycle (at-least-once semantics).
			if (adapters.schedule) {
				await adapters.schedule.acknowledgeDue(member.name, cycleStart).catch((err) => {
					console.error(`[runner] acknowledgeDue failed for ${member.name}: ${err.message}`);
				});
			}
			// Commit triggers need no post-cycle acknowledgement: pendingMatches
			// advances the scan cursor eagerly (before the agent runs) and a match,
			// once found, is durable until the agent calls clear_trigger_matches —
			// see triggers/file.mjs.
			if (adapters.watches) {
				await adapters.watches.acknowledgeObservations(member.name).catch((err) => {
					console.error(`[runner] watches.acknowledgeObservations failed for ${member.name}: ${err.message}`);
				});
			}
		}

		console.log(`\n  Complete: ${member.name}\n`);

		if (membersWithWork.indexOf(member) < membersWithWork.length - 1 && failureState.consecutive === 0) {
			await new Promise((r) => setTimeout(r, 500));
		}
	}

	// Commit/sync after cycle
	if (!opts.noCommit && syncAdapter) {
		const names = membersWithWork.map((m) => m.name).join(', ');
		const label = `cycle ${cycleCount} (${priority}): ${names}`;
		await syncAdapter.push(repoRoot, label);
	}

	return { memberRuns, stopped, lastError };
}

// ─── Pass execution ────────────────────────────────────────────────────────────

export async function runPass({
	opts,
	teamDir,
	logsDir,
	version,
	repoRoot,
	members,
	schedulerState,
	useTimeout,
	syncAdapter,
	adapters,
}) {
	const { lastServedAt, lastServedMember, vruntime } = schedulerState;
	const weights = opts.weights;
	const startTime = Date.now();
	let cycleCount = 0;
	let totalMemberRuns = 0;
	const budgetSpent = {};
	const passErrors = [];
	const failureState = { consecutive: 0 };

	// Pull latest state before pass (S3 adapter syncs from remote; git adapter is no-op)
	if (syncAdapter) {
		await syncAdapter.pull(repoRoot);
	}

	// Eligible priorities based on --priority flag (this level and all below)
	const startIdx = PRIORITY_ORDER.indexOf(opts.priority);
	const eligiblePriorities = PRIORITY_ORDER.slice(startIdx);

	function isBudgetExhausted(priority) {
		const cap = opts.budgets[priority];
		if (cap == null) return false;
		return (budgetSpent[priority] ?? 0) >= cap;
	}

	while (cycleCount < opts.maxCycles) {
		// Probe host-side conditions before scanning for work. The adapter
		// throttles itself, so calling this every cycle is cheap.
		if (adapters.watches) {
			for (const member of members) {
				await adapters.watches.poll(member.name).catch((err) => {
					console.error(`[runner] watches.poll failed for ${member.name}: ${err.message}`);
				});
			}
		}

		if (useTimeout && Date.now() - startTime >= MAX_RUN_MS) {
			return { cycleCount, totalMemberRuns, stopped: false, timedOut: true, passErrors };
		}

		if (await checkStop(teamDir)) {
			return { cycleCount, totalMemberRuns, stopped: true, timedOut: false, passErrors };
		}
		if ((await waitWhilePaused(teamDir)) === 'stop') {
			return { cycleCount, totalMemberRuns, stopped: true, timedOut: false, passErrors };
		}

		// Scan all eligible priorities for work
		const candidates = [];
		for (const priority of eligiblePriorities) {
			if (isBudgetExhausted(priority)) continue;
			const cadence = opts.cadences[priority];
			if (cadence && Date.now() - (lastServedAt[priority] ?? 0) < cadence) continue;
			const membersWithWork = await getMembersWithWork(members, priority, teamDir, adapters);
			if (membersWithWork.length > 0) {
				candidates.push({ priority, members: membersWithWork });
			}
		}

		if (candidates.length === 0) {
			console.log('\n[runner] No work at any eligible priority.');
			break;
		}

		// Pick priority with lowest vruntime
		const pickedPriority = pickNextPriority(vruntime, candidates);
		const picked = candidates.find((c) => c.priority === pickedPriority);

		// Rotate members for round-robin fairness, then trim to budget
		let membersToRun = picked.members;
		const cap = opts.budgets[pickedPriority];
		if (cap != null) {
			membersToRun = rotateAfter(membersToRun, lastServedMember[pickedPriority]);
			const remaining = cap - (budgetSpent[pickedPriority] ?? 0);
			if (membersToRun.length > remaining) {
				membersToRun = membersToRun.slice(0, remaining);
			}
		}

		cycleCount++;
		const vrt = (vruntime[pickedPriority] ?? 0).toFixed(3);
		console.log(
			`\n[runner] Cycle ${cycleCount}, priority: ${pickedPriority} (vrt=${vrt}), ` +
				`members: ${membersToRun.map((m) => m.name).join(', ')}`,
		);

		const result = await runCycle({
			membersWithWork: membersToRun,
			priority: pickedPriority,
			cycleCount,
			opts,
			teamDir,
			logsDir,
			version,
			repoRoot,
			startTime,
			useTimeout,
			failureState,
			syncAdapter,
			adapters,
		});
		totalMemberRuns += result.memberRuns;
		if (result.lastError) passErrors.push(result.lastError);
		budgetSpent[pickedPriority] = (budgetSpent[pickedPriority] ?? 0) + result.memberRuns;
		if (membersToRun.length > 0) {
			lastServedMember[pickedPriority] = membersToRun[membersToRun.length - 1].name;
		}
		lastServedAt[pickedPriority] = Date.now();

		// Advance vruntime for the served priority and normalize
		vruntime[pickedPriority] = (vruntime[pickedPriority] ?? 0) + 1 / (weights[pickedPriority] ?? 1);
		normalizeVruntimes(vruntime);

		if (result.stopped) return { cycleCount, totalMemberRuns, stopped: true, timedOut: false, passErrors };
	}

	return { cycleCount, totalMemberRuns, stopped: false, timedOut: false, passErrors };
}
