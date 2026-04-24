import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTextOrEmpty, formatTimestamp, slugify, buildLogPath, buildToolsPromptSection } from './util.mjs';
import { runAgent } from './agents/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEAMOS_ROOT = join(__dirname, '..', '..');

const CLERK_DAILY_MS = 24 * 60 * 60 * 1000;
const EFFICIENCY_ANALYSIS_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Automated housekeeping ─────────────────────────────────────────────────────

/**
 * Run automated housekeeping: archive expired memos, prune stale schedule events,
 * validate JSON files.  Returns { fixed: string[], errors: string[] }.
 */
export async function runHousekeeping(teamDir, members) {
	const fixed = [];
	const errors = [];

	// 1. Archive expired memos
	const memosPath = join(teamDir, 'memos.json');
	try {
		const raw = await readFile(memosPath, 'utf-8');
		const memos = JSON.parse(raw);
		const now = new Date();
		const expired = (memos.items ?? []).filter(m => m.expiresAt && new Date(m.expiresAt) < now);
		if (expired.length > 0) {
			const archiveDir = join(teamDir, 'archives');
			await mkdir(archiveDir, { recursive: true });
			for (const memo of expired) {
				const archivePath = join(archiveDir, `memo-${slugify(memo.title)}.json`);
				await writeFile(archivePath, JSON.stringify(memo, null, '\t') + '\n', 'utf-8');
			}
			memos.items = memos.items.filter(m => !expired.includes(m));
			await writeFile(memosPath, JSON.stringify(memos, null, '\t') + '\n', 'utf-8');
			fixed.push(`Archived ${expired.length} expired memo(s)`);
		}
	} catch (e) {
		errors.push(`memos.json: ${e.message}`);
	}

	// 2. Prune non-recurring schedule events more than a week past due.
	// The adapter advances recurring events and clears fired one-time events
	// in acknowledgeDue; this guard only catches orphans from repeated cycle
	// failures. Presence of `recurrence` is the signal — the legacy
	// `recurring: true` flag is ignored because the adapter migrates it away.
	const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
	for (const member of members) {
		const schedulePath = join(teamDir, 'members', member.name, 'schedule.json');
		try {
			const raw = await readFile(schedulePath, 'utf-8');
			const schedule = JSON.parse(raw);
			const stale = (schedule.events ?? []).filter(e => !e.recurrence && new Date(e.time) < weekAgo);
			if (stale.length > 0) {
				schedule.events = schedule.events.filter(e => !stale.includes(e));
				await writeFile(schedulePath, JSON.stringify(schedule, null, '\t') + '\n', 'utf-8');
				fixed.push(`Pruned ${stale.length} stale event(s) from ${member.name}'s schedule`);
			}
		} catch { /* missing file is fine */ }
	}

	// 3. Archive completed/cancelled projects
	const projectsPath = join(teamDir, 'projects.json');
	try {
		const raw = await readFile(projectsPath, 'utf-8');
		const manifest = JSON.parse(raw);
		const done = (manifest.projects ?? []).filter(p => p.status === 'completed' || p.status === 'cancelled');
		if (done.length > 0) {
			const archiveDir = join(teamDir, 'archives');
			await mkdir(archiveDir, { recursive: true });
			for (const proj of done) {
				const archivePath = join(archiveDir, `project-${slugify(proj.code)}.json`);
				await writeFile(archivePath, JSON.stringify(proj, null, '\t') + '\n', 'utf-8');
			}
			manifest.projects = manifest.projects.filter(p => !done.includes(p));
			await writeFile(projectsPath, JSON.stringify(manifest, null, '\t') + '\n', 'utf-8');
			fixed.push(`Archived ${done.length} completed/cancelled project(s)`);
		}
	} catch (e) {
		errors.push(`projects.json: ${e.message}`);
	}

	// 4. Validate key JSON files
	for (const member of members) {
		for (const file of ['todo.json', 'schedule.json']) {
			const filePath = join(teamDir, 'members', member.name, file);
			try {
				const raw = await readFile(filePath, 'utf-8');
				JSON.parse(raw);
			} catch (e) {
				if (e.code !== 'ENOENT') errors.push(`${member.name}/${file}: ${e.message}`);
			}
		}
	}

	return { fixed, errors };
}

// ─── Log scanning (for efficiency analysis) ─────────────────────────────────────

export async function scanRecentLogs(logsDir, days = 7) {
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	let files;
	try { files = await readdir(logsDir); } catch { return []; }

	const entries = [];
	for (const file of files) {
		if (!file.endsWith('.log')) continue;
		const match = file.match(/^(.+?)\.(.+?)\.(\d{4}-\d{2}-\d{2}T(\d{2})-(\d{2})-(\d{2})-(\d+)Z)\.log$/);
		if (!match) continue;
		const [, member, priority, , hh, mm, ss, ms] = match;
		const tsStr = match[3].replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z/, '$1T$2:$3:$4.$5Z');
		const ts = new Date(tsStr);
		if (isNaN(ts.getTime()) || ts.getTime() < cutoff) continue;

		const content = await readTextOrEmpty(join(logsDir, file));
		const tail = content.slice(-600);
		const costMatch = tail.match(/cost \$([0-9.]+)/);
		const durMatch = tail.match(/\| ([0-9.]+)s/);
		const rateLimited = content.includes('"status":"rejected"');

		entries.push({
			file, member, priority,
			timestamp: ts.toISOString(),
			cost: costMatch ? parseFloat(costMatch[1]) : 0,
			durationSec: durMatch ? parseFloat(durMatch[1]) : 0,
			rateLimited,
			sizeKB: Math.round(content.length / 1024),
		});
	}

	return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function buildLogSummary(entries) {
	const byMember = {};
	for (const e of entries) {
		if (e.member === 'clerk') continue;
		const key = e.member;
		if (!byMember[key]) byMember[key] = { runs: 0, totalCost: 0, rateLimited: 0, byPriority: {} };
		const m = byMember[key];
		m.runs++;
		m.totalCost += e.cost;
		if (e.rateLimited) m.rateLimited++;
		if (!m.byPriority[e.priority]) m.byPriority[e.priority] = { runs: 0, cost: 0 };
		m.byPriority[e.priority].runs++;
		m.byPriority[e.priority].cost += e.cost;
	}

	const lines = ['| Member | Runs | Cost | Rate-limited | By priority |',
		'|--------|------|------|-------------|-------------|'];
	for (const [name, m] of Object.entries(byMember).sort((a, b) => b[1].totalCost - a[1].totalCost)) {
		const priStr = Object.entries(m.byPriority)
			.map(([p, d]) => `${p}:${d.runs}/$${d.cost.toFixed(2)}`)
			.join(', ');
		lines.push(`| ${name} | ${m.runs} | $${m.totalCost.toFixed(2)} | ${m.rateLimited} | ${priStr} |`);
	}
	return lines.join('\n');
}

export async function buildEfficiencyPrompt(teamDir, logsDir) {
	const rulesFile = join(TEAMOS_ROOT, 'agent-rules', 'clerk-efficiency.md');
	const rules = await readTextOrEmpty(rulesFile);
	const membersDoc = await readTextOrEmpty(join(teamDir, 'members.json'));

	const entries = await scanRecentLogs(logsDir, 7);
	const summaryTable = buildLogSummary(entries);

	const interesting = entries
		.filter(e => !e.rateLimited && e.member !== 'clerk')
		.sort((a, b) => b.cost - a.cost)
		.slice(0, 30);
	const logList = interesting.map(e =>
		`  ${e.file}  ($${e.cost.toFixed(2)}, ${e.durationSec.toFixed(0)}s, ${e.sizeKB}KB)`
	).join('\n');

	return [
		'# TeamOS Weekly Efficiency Analysis',
		`# Time: ${formatTimestamp()}`,
		`# Team directory: team/`,
		`# Logs directory: team/.logs/`,
		'',
		'## Team Members',
		'',
		membersDoc,
		'',
		'## Last 7 Days — Summary',
		'',
		summaryTable,
		'',
		'## Most Expensive Runs (non-rate-limited)',
		'',
		logList || '(none)',
		'',
		'## Rules',
		'',
		rules,
		'',
		...buildToolsPromptSection('efficiency'),
		'',
		'Use `send_message` to notify members of issues you find.',
		'',
		'## Instructions',
		'',
		'Analyze the logs listed above for repeated inefficiency patterns.',
		'Read the actual log files (in team/.logs/) to understand what the agent did.',
		'Use `send_message` ONLY for repeated patterns — not one-time fumbles.',
		'Do NOT commit — the runner handles commits after you complete.',
	].join('\n');
}

export async function buildClerkPrompt(teamDir, error) {
	const clerkRules = await readTextOrEmpty(join(TEAMOS_ROOT, 'agent-rules', 'clerk.md'));

	const parts = [
		'# TeamOS Clerk',
		`# Time: ${formatTimestamp()}`,
		`# Team directory: team/`,
		'',
		'## Clerk Rules',
		'',
		clerkRules,
		...buildToolsPromptSection('clerk'),
	];

	if (error) {
		parts.push(
			'',
			'## Error Context',
			'',
			'The following error occurred during the last cycle:',
			'',
			error,
		);
	}

	parts.push(
		'',
		'## Instructions',
		'',
		'Run cleanup as described in the clerk rules above.',
		'Do NOT commit — the runner handles commits after you complete.',
	);

	return parts.join('\n');
}

/**
 * Post-pass maintenance: automated housekeeping, conditional clerk, weekly efficiency analysis.
 * @param {Function} commitAndPush - async function(message) that commits and optionally pushes
 */
export async function runMaintenance({ opts, teamDir, logsDir, version, repoRoot, members, schedulerState, passErrors, syncAdapter }) {
	const now = Date.now();

	// 1. Automated housekeeping (lightweight JS — no agent)
	const issues = await runHousekeeping(teamDir, members);
	if (issues.fixed.length > 0) {
		console.log(`[runner] Housekeeping: ${issues.fixed.join('; ')}`);
		if (!opts.noCommit && syncAdapter) {
			await syncAdapter.push(repoRoot, 'housekeeping: automated cleanup');
			console.log('  Housekeeping committed.');
		}
	}
	if (issues.errors.length > 0) {
		console.log(`[runner] Housekeeping issues: ${issues.errors.join('; ')}`);
	}

	// 2. Clerk: run if issues need agent intervention, errors occurred, or ≥24h since last run
	const errorContext = [...(passErrors ?? []), ...issues.errors];
	const timeSinceClerk = now - (schedulerState.lastClerkAt ?? 0);
	const needsClerk = errorContext.length > 0 || timeSinceClerk >= CLERK_DAILY_MS;

	if (needsClerk && !opts.noClerk) {
		console.log('\n[runner] Running daily clerk...');
		const clerkLog = buildLogPath(logsDir, 'clerk', 'maintenance');

		await writeFile(clerkLog, [
			`Clerk run (maintenance)`,
			`Agent: ${opts.agent}`,
			`TeamOS: ${version}`,
			`Started: ${new Date().toISOString()}`,
			errorContext.length > 0 ? `Issues: ${errorContext.join('; ')}` : 'No issues.',
			'═'.repeat(72),
			'',
		].join('\n'));

		const clerkPrompt = await buildClerkPrompt(teamDir, errorContext.length > 0 ? errorContext.join('\n') : null);
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

		if (!opts.noCommit && syncAdapter) {
			await syncAdapter.push(repoRoot, 'clerk: maintenance');
			console.log('  Clerk committed.');
		}

		schedulerState.lastClerkAt = Date.now();
	}

	// 3. Weekly efficiency analysis
	const timeSinceAnalysis = now - (schedulerState.lastEfficiencyAt ?? 0);
	if (!opts.noClerk && timeSinceAnalysis >= EFFICIENCY_ANALYSIS_MS) {
		console.log('\n[runner] Running weekly efficiency analysis...');
		const analysisLog = buildLogPath(logsDir, 'clerk', 'efficiency');

		await writeFile(analysisLog, [
			`Clerk run (weekly efficiency analysis)`,
			`Agent: ${opts.agent}`,
			`TeamOS: ${version}`,
			`Started: ${new Date().toISOString()}`,
			'═'.repeat(72),
			'',
		].join('\n'));

		const prompt = await buildEfficiencyPrompt(teamDir, logsDir);
		const analysisExit = await runAgent(opts.agent, prompt, repoRoot, analysisLog, {
			teamDir,
			memberName: 'clerk',
			messagingAdapterName: opts.messaging,
			tasksAdapterName: opts.tasks,
			scheduleAdapterName: opts.schedule,
			triggersAdapterName: opts.triggers,
		});

		if (analysisExit !== 0) {
			console.error(`[runner] Efficiency analysis exited with code ${analysisExit}`);
		}

		if (!opts.noCommit && syncAdapter) {
			await syncAdapter.push(repoRoot, 'clerk: weekly efficiency analysis');
			console.log('  Analysis committed.');
		}

		schedulerState.lastEfficiencyAt = Date.now();
	}
}
