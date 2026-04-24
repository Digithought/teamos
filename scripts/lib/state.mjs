import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIORITY_ORDER } from './scheduler.mjs';
import { checkStop } from './util.mjs';

const IDLE_POLL_MS = 30 * 1000;

export async function loadSchedulerState(logsDir) {
	try {
		const raw = await readFile(join(logsDir, 'scheduler-state.json'), 'utf-8');
		const state = JSON.parse(raw);
		const now = Date.now();
		const lastServedAt = {};
		const vruntime = {};
		for (const p of PRIORITY_ORDER) {
			const ts = state.lastServedAt?.[p];
			lastServedAt[p] = (typeof ts === 'number' && ts > 0 && ts <= now) ? ts : now;
			const v = state.vruntime?.[p];
			vruntime[p] = (typeof v === 'number' && isFinite(v)) ? v : 0;
		}
		const lastServedMember = state.lastServedMember ?? {};
		const validTs = (v) => typeof v === 'number' && v > 0 && v <= now ? v : 0;
		const lastClerkAt = validTs(state.lastClerkAt);
		const lastEfficiencyAt = validTs(state.lastEfficiencyAt);
		console.log('[runner] Restored scheduler state from previous run.');
		return { lastServedAt, lastServedMember, vruntime, lastClerkAt, lastEfficiencyAt };
	} catch {
		const lastServedAt = {};
		const vruntime = {};
		for (const p of PRIORITY_ORDER) {
			lastServedAt[p] = Date.now();
			vruntime[p] = 0;
		}
		return { lastServedAt, lastServedMember: {}, vruntime, lastClerkAt: 0, lastEfficiencyAt: 0 };
	}
}

export async function saveSchedulerState(logsDir, state) {
	const out = {
		lastServedAt: state.lastServedAt,
		lastServedMember: state.lastServedMember,
		vruntime: state.vruntime,
		lastClerkAt: state.lastClerkAt,
		lastEfficiencyAt: state.lastEfficiencyAt,
		updatedAt: new Date().toISOString(),
	};
	await writeFile(
		join(logsDir, 'scheduler-state.json'),
		JSON.stringify(out, null, '\t') + '\n', 'utf-8',
	).catch(() => {});
}

/**
 * Wait for the specified duration, polling for stop files or new work.
 * @param {Function} getMembersWithWork - async function(members, priority, teamDir) => member[]
 * @param {Object} [remote] - optional periodic remote-pull during idle
 * @param {Object} remote.syncAdapter - adapter with pull(workDir)
 * @param {string} remote.workDir - repo root passed to syncAdapter.pull
 * @param {number} remote.intervalMs - min ms between remote pulls (0 disables)
 */
export async function idleWait(ms, teamDir, members, lastServedAt, cadences, getMembersWithWork, remote = null) {
	const end = Date.now() + ms;
	let lastRemotePullAt = Date.now();
	while (Date.now() < end) {
		if (await checkStop(teamDir)) return 'stop';

		if (remote?.syncAdapter?.pull && remote.intervalMs > 0
			&& (Date.now() - lastRemotePullAt) >= remote.intervalMs) {
			try { await remote.syncAdapter.pull(remote.workDir); } catch {}
			lastRemotePullAt = Date.now();
		}

		for (const priority of ['pressing', 'today']) {
			const cadence = cadences[priority] ?? 0;
			if (cadence && (Date.now() - (lastServedAt[priority] ?? 0)) < cadence) continue;
			if ((await getMembersWithWork(members, priority, teamDir)).length > 0) return 'work';
		}
		const remaining = end - Date.now();
		const delay = Math.min(IDLE_POLL_MS, remaining);
		if (delay > 0) await new Promise(r => setTimeout(r, delay));
	}
	return 'interval';
}
