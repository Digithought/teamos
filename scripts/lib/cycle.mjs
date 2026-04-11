import { readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTextOrEmpty, formatTimestamp, buildLogPath, checkStop } from './util.mjs';
import { PRIORITY_ORDER, pickNextPriority, normalizeVruntimes, rotateAfter } from './scheduler.mjs';
import { runAgent } from './agents/index.mjs';
import { advanceRecurringEvents, getMembersWithWork } from './work-detection.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEAMOS_ROOT = join(__dirname, '..', '..');

const MAX_RUN_MS = 60 * 60 * 1000;      // 1 hour hard stop (single-run mode only)
const BACKOFF_INITIAL_MS = 30 * 1000;    // 30 seconds after first failure
const BACKOFF_MAX_MS = 30 * 60 * 1000;   // cap at 30 minutes

// ─── Prompt building ───────────────────────────────────────────────────────────

async function readInboxMessages(memberDir) {
	const inboxDir = join(memberDir, 'inbox');
	try {
		const files = await readdir(inboxDir);
		const mdFiles = files.filter(f => f.endsWith('.md'));
		const messages = [];
		for (const file of mdFiles) {
			const content = await readTextOrEmpty(join(inboxDir, file));
			if (content) messages.push({ file, content });
		}
		return messages;
	} catch {
		return [];
	}
}

export async function buildCyclePrompt(member, priority, teamDir, messagingAdapter) {
	const memberDir = join(teamDir, 'members', member.name);
	const rulesFile = join(TEAMOS_ROOT, 'agent-rules', 'cycle.md');

	const [rules, orgDoc, memosDoc, projectsDoc, membersDoc,
		profile, state, todos, schedule] = await Promise.all([
		readTextOrEmpty(rulesFile),
		readTextOrEmpty(join(teamDir, 'org.md')),
		readTextOrEmpty(join(teamDir, 'memos.json')),
		readTextOrEmpty(join(teamDir, 'projects.json')),
		readTextOrEmpty(join(teamDir, 'members.json')),
		readTextOrEmpty(join(memberDir, 'profile.md')),
		readTextOrEmpty(join(memberDir, 'state.md')),
		readTextOrEmpty(join(memberDir, 'todo.json')),
		readTextOrEmpty(join(memberDir, 'schedule.json')),
	]);

	const inboxMessages = await readInboxMessages(memberDir);

	const parts = [
		`# TeamOS Cycle: ${member.name} (${member.title})`,
		`# Priority: ${priority}`,
		`# Time: ${formatTimestamp()}`,
		`# Team directory: team/`,
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
		todos || '{"items":[]}',
		'',
		'## Your Schedule',
		'',
		schedule || '{"events":[]}',
	];

	// If a messaging adapter is available, tell the agent about its tools
	// and still include a preview of pending messages for context
	if (messagingAdapter) {
		const messages = await messagingAdapter.getMessages(member.name);
		parts.push('', '## Messaging');
		parts.push('', 'You have messaging tools available via MCP:');
		parts.push('- **send_message** — Send a message to team members');
		parts.push('- **read_messages** — Read your pending inbox messages');
		parts.push('- **acknowledge_message** — Mark a message as processed');
		parts.push('- **list_conversations** — List active conversations');
		parts.push('');
		if (messages.length > 0) {
			parts.push(`You have **${messages.length}** pending message(s). Use read_messages to read them and acknowledge_message after processing each one.`);
		} else {
			parts.push('No pending messages.');
		}
	} else {
		// Fallback: inline inbox messages (original behavior, no MCP)
		if (inboxMessages.length > 0) {
			parts.push('', '## Your Inbox Messages', '');
			for (const msg of inboxMessages) {
				parts.push(`### ${msg.file}`, '', msg.content, '');
			}
		} else {
			parts.push('', '## Your Inbox', '', 'No messages.', '');
		}
	}

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

export async function runCycle({ membersWithWork, priority, cycleCount, opts, teamDir, logsDir, version, repoRoot, startTime, useTimeout, failureState, syncAdapter, messagingAdapter }) {
	let memberRuns = 0;
	let lastError = null;
	let stopped = false;

	for (const member of membersWithWork) {
		if (useTimeout && (Date.now() - startTime) >= MAX_RUN_MS) break;
		if (await checkStop(teamDir)) { stopped = true; break; }

		// Exponential backoff after consecutive failures (e.g. network outage)
		if (failureState.consecutive > 0) {
			const delay = Math.min(BACKOFF_INITIAL_MS * 2 ** (failureState.consecutive - 1), BACKOFF_MAX_MS);
			console.log(`[runner] ${failureState.consecutive} consecutive failure(s) — backing off ${Math.round(delay / 1000)}s before next member.`);
			await new Promise(r => setTimeout(r, delay));
			if (await checkStop(teamDir)) { stopped = true; break; }
		}

		memberRuns++;
		const currentLog = buildLogPath(logsDir, member.name, priority);

		console.log([
			`${'─'.repeat(72)}`,
			`  ${member.name} (${member.title})`,
			`  Priority: ${priority}  |  Cycle: ${cycleCount}`,
			`  Log: ${currentLog}`,
			`${'─'.repeat(72)}`,
		].join('\n'));

		await writeFile(currentLog, [
			`Member: ${member.name} (${member.title})`,
			`Priority: ${priority}`,
			`Agent: ${opts.agent}`,
			`TeamOS: ${version}`,
			`Started: ${new Date().toISOString()}`,
			'═'.repeat(72),
			'',
		].join('\n'));

		const prompt = await buildCyclePrompt(member, priority, teamDir, messagingAdapter);
		const mcpContext = messagingAdapter ? {
			teamDir,
			memberName: member.name,
			messagingAdapter: opts.messaging || 'file',
		} : undefined;
		const exitCode = await runAgent(opts.agent, prompt, repoRoot, currentLog, mcpContext);

		if (exitCode !== 0) {
			failureState.consecutive++;
			lastError = `Agent exited with code ${exitCode} for member: ${member.name}`;
			console.error(`\n${lastError}`);
			console.error(`Log: ${currentLog}`);
		} else {
			failureState.consecutive = 0;
		}

		console.log(`\n  Complete: ${member.name}\n`);

		await advanceRecurringEvents(member.name, teamDir);

		if (membersWithWork.indexOf(member) < membersWithWork.length - 1 && failureState.consecutive === 0) {
			await new Promise(r => setTimeout(r, 500));
		}
	}

	// Commit/sync after cycle
	if (!opts.noCommit && syncAdapter) {
		const names = membersWithWork.map(m => m.name).join(', ');
		const label = `cycle ${cycleCount} (${priority}): ${names}`;
		await syncAdapter.push(repoRoot, label);
	}

	return { memberRuns, stopped, lastError };
}

// ─── Pass execution ────────────────────────────────────────────────────────────

export async function runPass({ opts, teamDir, logsDir, version, repoRoot, members, schedulerState, useTimeout, syncAdapter, messagingAdapter }) {
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
		if (useTimeout && (Date.now() - startTime) >= MAX_RUN_MS) {
			return { cycleCount, totalMemberRuns, stopped: false, timedOut: true, passErrors };
		}

		if (await checkStop(teamDir)) {
			return { cycleCount, totalMemberRuns, stopped: true, timedOut: false, passErrors };
		}

		// Scan all eligible priorities for work
		const candidates = [];
		for (const priority of eligiblePriorities) {
			if (isBudgetExhausted(priority)) continue;
			const cadence = opts.cadences[priority];
			if (cadence && (Date.now() - (lastServedAt[priority] ?? 0)) < cadence) continue;
			const membersWithWork = await getMembersWithWork(members, priority, teamDir, messagingAdapter);
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
		const picked = candidates.find(c => c.priority === pickedPriority);

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
		console.log(`\n[runner] Cycle ${cycleCount}, priority: ${pickedPriority} (vrt=${vrt}), ` +
			`members: ${membersToRun.map(m => m.name).join(', ')}`);

		const result = await runCycle({
			membersWithWork: membersToRun, priority: pickedPriority, cycleCount,
			opts, teamDir, logsDir, version, repoRoot, startTime, useTimeout, failureState,
			syncAdapter, messagingAdapter,
		});
		totalMemberRuns += result.memberRuns;
		if (result.lastError) passErrors.push(result.lastError);
		budgetSpent[pickedPriority] = (budgetSpent[pickedPriority] ?? 0) + result.memberRuns;
		if (membersToRun.length > 0) {
			lastServedMember[pickedPriority] = membersToRun[membersToRun.length - 1].name;
		}
		lastServedAt[pickedPriority] = Date.now();

		// Advance vruntime for the served priority and normalize
		vruntime[pickedPriority] = (vruntime[pickedPriority] ?? 0) + (1 / (weights[pickedPriority] ?? 1));
		normalizeVruntimes(vruntime);

		if (result.stopped) return { cycleCount, totalMemberRuns, stopped: true, timedOut: false, passErrors };
	}

	return { cycleCount, totalMemberRuns, stopped: false, timedOut: false, passErrors };
}
