#!/usr/bin/env node
/**
 * TeamOS Runner — orchestrates member cycles using weighted fair scheduling
 * by invoking an agentic CLI tool for each active AI member.
 *
 * Version: 2.0.0
 *
 * Usage:
 *   node teamos/scripts/run.mjs [options]
 *
 * Options:
 *   --agent <name>       Agent adapter: claude | auggie | cursor  (default: claude)
 *   --messaging <name>   Messaging adapter: file                  (default: file)
 *   --tasks <name>       Tasks adapter: file                      (default: file)
 *   --schedule <name>    Schedule adapter: file                   (default: file)
 *   --sync <name>        Sync adapter: git | s3                   (default: git)
 *   --priority <level>   Highest priority to include              (default: pressing)
 *   --member <name>      Only run cycles for a specific member
 *   --max-cycles <n>     Max cycle passes per scheduling pass     (default: 10)
 *   --once               Single pass (no loop)
 *   --loop               Enable continuous scheduling loop (default in hosted mode)
 *   --interval <min>     Minutes between passes (default: 120, implies --loop)
 *   --remote-pull-interval <min>  Minutes between idle git pulls (default: 5, 0 disables)
 *   --push               Push to remote after each commit (git sync)
 *   --no-commit          Skip automatic sync after each cycle
 *   --no-clerk           Skip clerk agent after each pass
 *   --clerk-only         Run only the clerk agent, then exit
 *   --weight <pri:n>     Priority weight for fair scheduling (repeatable)
 *   --cadence <pri:dur>  Min time between serving a priority (repeatable)
 *   --budget <pri:n>     Optional max member cycles at a priority per pass (repeatable)
 *   --dry-run            List members with work, don't invoke agent
 *   --help               Show this help
 */

// Force synchronous stdout/stderr writes when output is a pipe (containers,
// CI). Without this, Node block-buffers and the startup banner / pass output
// can stall until enough output accumulates to fill the buffer (~16KB), which
// makes the runner look hung in `fly logs` while it's actually idling.
process.stdout._handle?.setBlocking?.(true);
process.stderr._handle?.setBlocking?.(true);

import { join, dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { pathExists, ensureLogsDir, buildLogPath, checkStop, waitWhilePaused } from './lib/util.mjs';
import { PRIORITY_ORDER, DEFAULT_PRIORITY_WEIGHTS, DEFAULT_CADENCE_MS } from './lib/scheduler.mjs';
import { loadSchedulerState, saveSchedulerState, idleWait } from './lib/state.mjs';
import { runAgent } from './lib/agents/index.mjs';
import { loadMembers, getMembersWithWork, ensureSelfAssessmentEvents, ensureDailyCheckinEvents } from './lib/work-detection.mjs';
import { runMaintenance, buildClerkPrompt } from './lib/maintenance.mjs';
import { runCycle, runPass } from './lib/cycle.mjs';
import { createMessagingAdapter } from './lib/messaging/index.mjs';
import { createTasksAdapter } from './lib/tasks/index.mjs';
import { createScheduleAdapter } from './lib/schedule/index.mjs';
import { createTriggersAdapter } from './lib/triggers/index.mjs';
import { createSyncAdapter } from './lib/sync/index.mjs';
import { loadConfig, resolveEnvVars, loadDotEnv } from './lib/config.mjs';

// ─── Path resolution ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEAMOS_ROOT = join(__dirname, '..');

const DEFAULT_INTERVAL_MS = 2 * 60 * 60 * 1000;  // 2 hours between passes
const DEFAULT_REMOTE_PULL_MS = 5 * 60 * 1000;    // 5 min between idle remote pulls

function getVersion() {
	try {
		return execSync('git log -1 --format=%h', { cwd: TEAMOS_ROOT, encoding: 'utf-8' }).trim();
	} catch {
		return 'unknown';
	}
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

function printHelp() {
	const lines = [
		'TeamOS Runner — orchestrate member cycles via agentic CLI',
		'',
		'Members are discovered from team/members.json.  Work is detected by',
		'checking pending messages, todos at the current priority, and due',
		'schedule events.  A weighted fair scheduler (vruntime) allocates cycles across',
		'priority levels: pressing → today → thisWeek → later.',
		'',
		'Usage: node teamos/scripts/run.mjs [options]',
		'',
		'Options:',
		'  --agent <name>       claude | auggie | cursor              (default: claude)',
		'  --messaging <name>   file                                 (default: file)',
		'  --tasks <name>       file                                 (default: file)',
		'  --schedule <name>    file                                 (default: file)',
		'  --triggers <name>    file                                 (default: file)',
		'  --sync <name>        git | s3                             (default: git)',
		'  --priority <level>   Highest priority to include           (default: pressing)',
		'  --member <name>      Only run cycles for a specific member',
		'  --max-cycles <n>     Max cycle passes per scheduling pass  (default: 10)',
		'  --once               Single pass, then exit',
		'  --loop               Enable continuous scheduling loop     (default)',
		'  --interval <min>     Minutes between passes                (default: 120)',
		'  --remote-pull-interval <min>  Minutes between idle git pulls (default: 5, 0 disables)',
		'  --push               Push to remote after each commit',
		'  --no-commit          Skip automatic sync after each cycle',
		'  --no-clerk           Skip clerk agent after each pass',
		'  --clerk-only         Run only the clerk agent, then exit',
		'  --weight <pri:n>     Priority weight for fair scheduling (repeatable)',
		'                         (defaults: pressing:8, today:4, thisWeek:2, later:1)',
		'  --cadence <pri:dur>  Min time between serving a priority (repeatable)',
		'                         (defaults: pressing:0h, today:4h, thisWeek:1d, later:3d)',
		'  --budget <pri:n>     Optional max member cycles at a priority per pass (repeatable)',
		'  --dry-run            List members with work, don\'t invoke agent',
		'  --help               Show this help',
	];
	console.log(lines.join('\n'));
}

function parseArgs(argv) {
	const opts = {
		agent: null,         // resolved from config if not set
		messaging: null,     // resolved from config if not set
		tasks: null,         // resolved from config if not set
		schedule: null,      // resolved from config if not set
		triggers: null,      // resolved from config if not set
		sync: null,          // resolved from config if not set
		priority: 'pressing',
		member: null,
		maxCycles: 10,
		loop: true,          // loop is now the default
		once: false,
		intervalMs: DEFAULT_INTERVAL_MS,
		remotePullMs: DEFAULT_REMOTE_PULL_MS,
		push: false,
		noCommit: false,
		noClerk: false,
		clerkOnly: false,
		dryRun: false,
		budgets: {},
		weights: { ...DEFAULT_PRIORITY_WEIGHTS },
		cadences: { ...DEFAULT_CADENCE_MS },
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--agent':
				opts.agent = argv[++i];
				break;
			case '--messaging':
				opts.messaging = argv[++i];
				break;
			case '--tasks':
				opts.tasks = argv[++i];
				break;
			case '--schedule':
				opts.schedule = argv[++i];
				break;
			case '--triggers':
				opts.triggers = argv[++i];
				break;
			case '--sync':
				opts.sync = argv[++i];
				break;
			case '--priority':
				opts.priority = argv[++i];
				break;
			case '--member':
				opts.member = argv[++i];
				break;
			case '--max-cycles':
				opts.maxCycles = parseInt(argv[++i], 10);
				break;
			case '--once':
				opts.once = true;
				opts.loop = false;
				break;
			case '--loop':
				opts.loop = true;
				opts.once = false;
				break;
			case '--interval':
				opts.intervalMs = parseInt(argv[++i], 10) * 60 * 1000;
				opts.loop = true;
				opts.once = false;
				break;
			case '--remote-pull-interval': {
				const mins = parseInt(argv[++i], 10);
				if (isNaN(mins) || mins < 0) {
					console.error('Invalid --remote-pull-interval: expected non-negative minutes (0 disables).');
					process.exit(1);
				}
				opts.remotePullMs = mins * 60 * 1000;
				break;
			}
			case '--push':
				opts.push = true;
				break;
			case '--no-commit':
				opts.noCommit = true;
				break;
			case '--no-clerk':
				opts.noClerk = true;
				break;
			case '--clerk-only':
				opts.clerkOnly = true;
				break;
			case '--budget': {
				const spec = argv[++i];
				if (spec) {
					const [pri, count] = spec.split(':');
					if (PRIORITY_ORDER.includes(pri) && !isNaN(parseInt(count, 10))) {
						opts.budgets[pri] = parseInt(count, 10);
					} else {
						console.error(`Invalid --budget spec: "${spec}". Use priority:count (e.g. later:2)`);
						process.exit(1);
					}
				}
				break;
			}
			case '--weight': {
				const spec = argv[++i];
				if (spec) {
					const [pri, w] = spec.split(':');
					if (PRIORITY_ORDER.includes(pri) && !isNaN(parseFloat(w)) && parseFloat(w) > 0) {
						opts.weights[pri] = parseFloat(w);
					} else {
						console.error(`Invalid --weight spec: "${spec}". Use priority:weight (e.g. pressing:8)`);
						process.exit(1);
					}
				}
				break;
			}
			case '--cadence': {
				const spec = argv[++i];
				if (spec) {
					const [pri, val] = spec.split(':');
					if (PRIORITY_ORDER.includes(pri) && val) {
						const unit = val.slice(-1);
						const num = parseFloat(val.slice(0, -1));
						const multiplier = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : NaN;
						if (!isNaN(num) && !isNaN(multiplier) && num >= 0) {
							opts.cadences[pri] = num * multiplier;
						} else {
							console.error(`Invalid --cadence value: "${val}". Use <number>h or <number>d (e.g. today:4h, later:3d)`);
							process.exit(1);
						}
					} else {
						console.error(`Invalid --cadence spec: "${spec}". Use priority:duration (e.g. today:4h, thisWeek:1d)`);
						process.exit(1);
					}
				}
				break;
			}
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--help':
				printHelp();
				process.exit(0);
		}
	}

	if (!PRIORITY_ORDER.includes(opts.priority)) {
		console.error(`Unknown priority: "${opts.priority}". Valid: ${PRIORITY_ORDER.join(', ')}`);
		process.exit(1);
	}

	return opts;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	const repoRoot = process.env.TEAMOS_TEAM_DIR
		? join(process.env.TEAMOS_TEAM_DIR, '..')
		: process.cwd();

	// Load .env before anything else so $VAR references in config resolve
	loadDotEnv(repoRoot);

	const teamDir = process.env.TEAMOS_TEAM_DIR || join(repoRoot, 'team');
	const version = getVersion();

	if (!await pathExists(teamDir)) {
		console.error('team/ directory not found. Run `node teamos/scripts/init.mjs` first.');
		process.exit(1);
	}

	// ── Load config ──────────────────────────────────────────────────────────
	const config = resolveEnvVars(await loadConfig(repoRoot));

	// Merge config defaults with CLI overrides
	if (!opts.agent) opts.agent = config.agent || 'claude';
	if (!opts.messaging) opts.messaging = config.messaging?.adapter || 'file';
	if (!opts.tasks) opts.tasks = config.tasks?.adapter || 'file';
	if (!opts.schedule) opts.schedule = config.schedule?.adapter || 'file';
	if (!opts.triggers) opts.triggers = config.triggers?.adapter || 'file';
	if (!opts.sync) opts.sync = config.sync?.adapter || 'git';

	// ── Create adapters ──────────────────────────────────────────────────────
	const syncAdapter = opts.noCommit
		? null
		: await createSyncAdapter(opts.sync, { ...config, git: { push: opts.push, ...(config.git || {}) } });

	const messagingAdapter = await createMessagingAdapter(opts.messaging, config, teamDir);
	const tasksAdapter = await createTasksAdapter(opts.tasks, config, teamDir);
	const scheduleAdapter = await createScheduleAdapter(opts.schedule, config, teamDir);
	const triggersAdapter = await createTriggersAdapter(opts.triggers, config, teamDir, repoRoot);

	// ── Load members ─────────────────────────────────────────────────────────
	const allMembers = await loadMembers(teamDir);
	const members = opts.member
		? allMembers.filter(m => m.name === opts.member)
		: allMembers;

	if (members.length === 0) {
		console.log(opts.member
			? `Member "${opts.member}" not found or not active.`
			: 'No active AI members found in team/members.json.');
		return;
	}

	// ── Ensure recurring system events ────────────────────────────────────────
	// Both injectors default to on; disable by setting the corresponding flag
	// to false under `schedule.autoEvents` in teamos.config.json.

	const autoEvents = config.schedule?.autoEvents || {};
	if (autoEvents.weeklySelfAssessment !== false) {
		await ensureSelfAssessmentEvents(allMembers, scheduleAdapter);
	}
	if (autoEvents.dailyCheckin !== false) {
		await ensureDailyCheckinEvents(allMembers, scheduleAdapter);
	}

	// ── Clerk only ────────────────────────────────────────────────────────────

	if (opts.clerkOnly) {
		console.log(`\nteamos (${version}) — clerk only`);
		const logsDir = await ensureLogsDir(teamDir);
		const clerkLog = buildLogPath(logsDir, 'clerk', 'manual');

		await writeFile(clerkLog, [
			`Clerk run (manual)`,
			`Agent: ${opts.agent}`,
			`TeamOS: ${version}`,
			`Started: ${new Date().toISOString()}`,
			'═'.repeat(72),
			'',
		].join('\n'));

		const clerkPrompt = await buildClerkPrompt(teamDir, null);
		const clerkExit = await runAgent(opts.agent, clerkPrompt, repoRoot, clerkLog, {
			teamDir,
			memberName: 'clerk',
			messagingAdapterName: opts.messaging,
			tasksAdapterName: opts.tasks,
			scheduleAdapterName: opts.schedule,
			triggersAdapterName: opts.triggers,
		});

		if (clerkExit !== 0) {
			console.error(`[runner] Clerk exited with code ${clerkExit}`);
		}

		if (syncAdapter) {
			await syncAdapter.push(repoRoot, 'clerk: manual');
			console.log('  Clerk committed.');
		}

		console.log('\nDone — clerk only.');
		return;
	}

	// ── Dry run ────────────────────────────────────────────────────────────────

	if (opts.dryRun) {
		console.log(`\nteamos (${version})`);
		console.log(`Active AI members: ${members.map(m => m.name).join(', ')}\n`);
		console.log(`  Agent: ${opts.agent} | Messaging: ${opts.messaging} | Tasks: ${opts.tasks} | Schedule: ${opts.schedule} | Triggers: ${opts.triggers} | Sync: ${opts.sync}`);

		const weightStr = Object.entries(opts.weights).map(([p, w]) => `${p}:${w}`).join(', ');
		const cadenceStr = Object.entries(opts.cadences)
			.map(([p, ms]) => {
				if (ms === 0) return `${p}:0`;
				if (ms >= 86400000) return `${p}:${Math.round(ms / 86400000)}d`;
				return `${p}:${Math.round(ms / 3600000)}h`;
			})
			.join(', ');
		console.log(`  Weights: ${weightStr}`);
		console.log(`  Cadences: ${cadenceStr}`);

		const logsDir = await ensureLogsDir(teamDir);
		const state = await loadSchedulerState(logsDir);
		console.log(`  Vruntimes: ${Object.entries(state.vruntime).map(([p, v]) => `${p}:${v.toFixed(3)}`).join(', ')}\n`);

		for (const priority of PRIORITY_ORDER) {
			const withWork = await getMembersWithWork(members, priority, teamDir, messagingAdapter, scheduleAdapter, tasksAdapter, triggersAdapter);
			if (withWork.length > 0) {
				console.log(`  [${priority}]`);
				for (const m of withWork) {
					console.log(`    ${m.name} (${m.title})`);
				}
			}
		}

		console.log();
		return;
	}

	// ── Run ────────────────────────────────────────────────────────────────────

	const weightStr = Object.entries(opts.weights)
		.map(([p, w]) => `${p}:${w}`)
		.join(', ');
	const cadenceStr = Object.entries(opts.cadences)
		.map(([p, ms]) => {
			if (ms === 0) return `${p}:0`;
			if (ms >= 86400000) return `${p}:${Math.round(ms / 86400000)}d`;
			return `${p}:${Math.round(ms / 3600000)}h`;
		})
		.join(', ');
	const budgetStr = Object.entries(opts.budgets)
		.map(([p, n]) => `${p}:${n}`)
		.join(', ');
	const banner = [
		'═'.repeat(72),
		`  teamos (${version})${opts.loop ? ' [loop mode]' : ' [single pass]'}`,
		`  ${members.length} active AI member(s): ${members.map(m => m.name).join(', ')}`,
		`  Agent: ${opts.agent} | Messaging: ${opts.messaging} | Tasks: ${opts.tasks} | Schedule: ${opts.schedule} | Triggers: ${opts.triggers} | Sync: ${opts.sync}`,
		`  Weights: ${weightStr}`,
		`  Cadences: ${cadenceStr}`,
		budgetStr ? `  Budgets: ${budgetStr}` : null,
		opts.loop ? `  Interval: ${opts.intervalMs / 60000}min` : null,
		'═'.repeat(72),
	].filter(Boolean).join('\n');
	console.log(banner);

	const logsDir = await ensureLogsDir(teamDir);
	const schedulerState = await loadSchedulerState(logsDir);

	// Initialize sync adapter (one-time setup)
	if (syncAdapter) {
		await syncAdapter.init();
	}

	if (opts.loop) {
		let passNum = 0;

		while (true) {
			if (await checkStop(teamDir)) {
				console.log('\n[runner] Stop file detected — exiting loop.');
				break;
			}
			if (await waitWhilePaused(teamDir) === 'stop') {
				console.log('\n[runner] Stop file detected — exiting loop.');
				break;
			}

			passNum++;
			const passStart = Date.now();
			console.log(`\n${'═'.repeat(72)}`);
			console.log(`  Pass ${passNum} started at ${new Date().toISOString()}`);
			console.log('═'.repeat(72));

			const result = await runPass({
				opts, teamDir, logsDir, version, repoRoot, members, schedulerState,
				useTimeout: false, syncAdapter, messagingAdapter, tasksAdapter, scheduleAdapter, triggersAdapter,
			});

			// Post-pass maintenance
			if (!result.stopped) {
				await runMaintenance({
					opts, teamDir, logsDir, version, repoRoot, members, schedulerState,
					passErrors: result.passErrors, syncAdapter,
				});
			}
			console.log(`\n[runner] Pass ${passNum} complete — ${result.cycleCount} cycle(s), ${result.totalMemberRuns} member run(s).`);
			await saveSchedulerState(logsDir, schedulerState);

			if (result.stopped) {
				console.log('[runner] Stop file detected — exiting loop.');
				break;
			}

			const elapsed = Date.now() - passStart;
			const remaining = opts.intervalMs - elapsed;

			if (remaining > 0) {
				const mins = Math.round(remaining / 60000);
				console.log(`[runner] Idle for ~${mins}min until next interval.`);
				const reason = await idleWait(
					remaining, teamDir, members,
					schedulerState.lastServedAt, opts.cadences,
					(m, p, t) => getMembersWithWork(m, p, t, messagingAdapter, scheduleAdapter, tasksAdapter, triggersAdapter),
					syncAdapter ? { syncAdapter, workDir: repoRoot, intervalMs: opts.remotePullMs } : null,
				);
				if (reason === 'stop') {
					console.log('\n[runner] Stop file detected — exiting loop.');
					break;
				}
				if (reason === 'work') {
					console.log('[runner] New work detected — starting next pass early.');
				}
			} else {
				console.log(`[runner] Pass took ${Math.round(elapsed / 60000)}min (overran interval) — starting next pass.`);
			}
		}

		console.log('\nTeamOS loop ended.');
	} else {
		// Single pass mode (--once)
		const result = await runPass({
			opts, teamDir, logsDir, version, repoRoot, members, schedulerState,
			useTimeout: true, syncAdapter, messagingAdapter, tasksAdapter, scheduleAdapter, triggersAdapter,
		});

		await runMaintenance({
			opts, teamDir, logsDir, version, repoRoot, members, schedulerState,
			passErrors: result.passErrors, syncAdapter,
		});

		await saveSchedulerState(logsDir, schedulerState);

		if (result.cycleCount >= opts.maxCycles) {
			console.log(`\n[runner] Reached max cycles (${opts.maxCycles}).`);
		}
		if (result.timedOut) {
			console.log(`[runner] Reached time limit (60min).`);
		}

		console.log(`\nDone — ${result.cycleCount} cycle(s), ${result.totalMemberRuns} member run(s).`);
	}
}

main().catch((err) => {
	console.error('TeamOS runner failed:', err);
	process.exit(1);
});
