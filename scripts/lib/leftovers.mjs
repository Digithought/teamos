/**
 * Leftover check: what a member's cycle added to or changed in the working tree without
 * committing.  Members share one checkout, and a cycle ends when the agent stops talking —
 * background jobs and "I'll finish this next cycle" don't survive it — so edits left behind are
 * orphaned: nobody will come back for them, they block fast-forwards, and on disk they belong
 * to no one.  The runner snapshots the tree before a cycle and compares after; only one member
 * runs at a time, so anything new or changed is that member's.
 *
 * Signatures are status + content, so a file already dirty before the cycle counts only if the
 * member changed it further.  The team directory is excluded (members write it constantly and
 * it is synced separately), as is dirt *inside* submodules; a moved submodule pointer counts.
 */

import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

function git(cwd, args, input) {
	return execFileSync('git', args, { cwd, input, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

/** Parse `git status --porcelain=v1 -z` into [{ code, path }]; a rename's source entry is skipped. */
export function parseStatusZ(raw) {
	const out = [];
	const parts = raw.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		const code = entry.slice(0, 2);
		out.push({ code, path: entry.slice(3) });
		if (code[0] === 'R' || code[0] === 'C') i++;
	}
	return out;
}

/**
 * Map of dirty path → signature, or null when `repoRoot` isn't a git work tree.
 * @param {string} repoRoot
 * @param {string} [excludeDir] absolute directory to leave out (the team directory)
 */
export function snapshotDirty(repoRoot, excludeDir) {
	let raw;
	const spec = ['.'];
	const rel = excludeDir ? relative(resolve(repoRoot), resolve(excludeDir)) : '';
	if (rel && !rel.startsWith('..')) spec.push(`:(exclude)${rel}`);
	try {
		raw = git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--', ...spec]);
	} catch {
		return null;
	}
	const entries = parseStatusZ(raw);
	// Content hashes for everything still on disk; hash-object reads the paths from stdin.
	const present = entries.filter((e) => e.code[1] !== 'D' && e.code[0] !== 'D');
	const hashes = new Map();
	if (present.length > 0) {
		let lines = [];
		try {
			lines = git(repoRoot, ['hash-object', '--stdin-paths'], present.map((e) => e.path).join('\n')).split('\n');
		} catch {
			// A submodule path (a directory) makes hash-object fail; fall back to one at a time.
			lines = present.map((e) => {
				try {
					return git(repoRoot, ['hash-object', '--', e.path]).trim();
				} catch {
					try {
						return `dir:${git(resolve(repoRoot, e.path), ['rev-parse', 'HEAD']).trim()}`;
					} catch {
						return '?';
					}
				}
			});
		}
		present.forEach((e, i) => hashes.set(e.path, lines[i] ?? '?'));
	}
	return new Map(entries.map((e) => [e.path, `${e.code}:${hashes.get(e.path) ?? '-'}`]));
}

/** Paths dirty in `after` that were clean in `before` or changed since: [{ path, status }]. */
export function leftoversSince(before, after) {
	if (!before || !after) return [];
	const out = [];
	for (const [path, sig] of after) {
		if (before.get(path) !== sig) out.push({ path, status: sig.slice(0, 2) });
	}
	return out;
}

/** The message a resumed session gets: what it left, and what to do about it. */
export function buildCleanupPrompt(leftovers, { limit = 60 } = {}) {
	const shown = leftovers.slice(0, limit).map((l) => `    ${l.status} ${l.path}`);
	if (leftovers.length > limit) shown.push(`    … and ${leftovers.length - limit} more (git status)`);
	return [
		'[TeamOS runner] Your cycle has ended, but it left uncommitted changes in the shared checkout:',
		'',
		...shown,
		'',
		'Other members and processes work in this same checkout, and nobody will come back for these later — background jobs and plans to continue next cycle do not carry over. Resolve each one now:',
		'- finished and verified: commit it (and push if that is how your work normally lands);',
		'- unfinished but worth keeping: `git stash push -u -m "<member>: <what and why>" -- <paths>` and record the stash in your todos;',
		'- not wanted (superseded, scratch, experiments): revert it (`git checkout -- <path>`, or delete an untracked file).',
		'Touch only the paths listed above. Then stop; say in one line what you did with each.',
	].join('\n');
}
