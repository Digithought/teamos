/**
 * Restart-on-code-change.  A long-running loop keeps the code it started with: Node caches
 * every import, so a pin bump or checkout of this repo does nothing until the process restarts.
 * When a supervisor promises to restart us — it sets RUNNER_RESTART_EXIT_CODE, as digithought-srv's
 * `runner` wrapper does — the loop checks this repo's HEAD at each safe boundary and, if it moved
 * since startup, exits with that code so the supervisor starts it again on the new code.
 *
 * Without the variable this is inert: a hand-run or hosted loop never exits on its own.
 */

import { execFileSync } from 'node:child_process';

function headOf(root) {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return null;
	}
}

/**
 * Returns null when disabled (no supervisor, or HEAD unreadable at startup).  Otherwise
 * `{ exitCode, changed() }`, where `changed()` returns `{ from, to }` once HEAD differs from the
 * startup commit, else null.  An unreadable HEAD later (mid-checkout) reads as unchanged.
 */
export function watchCodeVersion(root, { env = process.env, head = headOf } = {}) {
	const raw = env.RUNNER_RESTART_EXIT_CODE;
	if (!raw) return null;
	const exitCode = Number.parseInt(raw, 10);
	if (!Number.isInteger(exitCode) || exitCode < 1 || exitCode > 255) return null;
	const start = head(root);
	if (!start) return null;
	return {
		exitCode,
		changed() {
			const now = head(root);
			return now && now !== start ? { from: start.slice(0, 7), to: now.slice(0, 7) } : null;
		},
	};
}
