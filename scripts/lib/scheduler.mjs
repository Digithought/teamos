/** Priority levels in order of urgency. */
export const PRIORITY_ORDER = ['pressing', 'today', 'thisWeek', 'later'];

/** Weights for fair scheduling — higher weight = more cycles. */
export const DEFAULT_PRIORITY_WEIGHTS = {
	pressing: 8,
	today:    4,
	thisWeek: 2,
	later:    1,
};

/** Max vruntime deficit a priority can accumulate while idle. */
export const MAX_VRUNTIME_DEFICIT = 3.0;

/** Minimum time between serving a priority. */
export const DEFAULT_CADENCE_MS = {
	pressing: 0,
	today:    4 * 60 * 60 * 1000,
	thisWeek: 24 * 60 * 60 * 1000,
	later:    3 * 24 * 60 * 60 * 1000,
};

/**
 * Pick the priority with the lowest vruntime among candidates that have work.
 * Candidates are iterated in PRIORITY_ORDER, so ties favor higher priority.
 */
export function pickNextPriority(vruntime, candidates) {
	let best = null;
	let bestVrt = Infinity;
	for (const { priority } of candidates) {
		const vrt = vruntime[priority] ?? 0;
		if (vrt < bestVrt) {
			bestVrt = vrt;
			best = priority;
		}
	}
	return best;
}

/**
 * Normalize vruntimes: subtract the minimum to prevent unbounded growth,
 * and cap any deficit at MAX_VRUNTIME_DEFICIT so a long-idle priority
 * cannot monopolize cycles when it suddenly has work.
 */
export function normalizeVruntimes(vruntime) {
	const values = Object.values(vruntime);
	if (values.length === 0) return;
	const minVrt = Math.min(...values);
	for (const p of Object.keys(vruntime)) {
		vruntime[p] -= minVrt;
	}
	const maxVrt = Math.max(...Object.values(vruntime));
	for (const p of Object.keys(vruntime)) {
		if (maxVrt - vruntime[p] > MAX_VRUNTIME_DEFICIT) {
			vruntime[p] = maxVrt - MAX_VRUNTIME_DEFICIT;
		}
	}
}

/** Rotate membersWithWork so the member after lastServed is first (round-robin fairness). */
export function rotateAfter(membersWithWork, lastServedName) {
	if (!lastServedName || membersWithWork.length <= 1) return membersWithWork;
	const idx = membersWithWork.findIndex(m => m.name === lastServedName);
	if (idx < 0) return membersWithWork;
	return [...membersWithWork.slice(idx + 1), ...membersWithWork.slice(0, idx + 1)];
}
