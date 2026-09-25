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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

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
/** `ended` names what just finished: the runner's `cycle` or a dashboard `chat`. */
export function buildCleanupPrompt(leftovers, { limit = 60, ended = 'cycle' } = {}) {
	const shown = leftovers.slice(0, limit).map((l) => `    ${l.status} ${l.path}`);
	if (leftovers.length > limit) shown.push(`    … and ${leftovers.length - limit} more (git status)`);
	return [
		`[TeamOS runner] Your ${ended} has ended, but it left uncommitted changes in the shared checkout:`,
		'',
		...shown,
		'',
		'Other members and processes work in this same checkout, and nobody will come back for these later — background jobs and plans to continue later do not carry over. Resolve each one now:',
		'- finished and verified: commit it (and push if that is how your work normally lands);',
		'- unfinished but worth keeping: `git stash push -u -m "<member>: <what and why>" -- <paths>` and record the stash in your todos;',
		'- not wanted (superseded, scratch, experiments): revert it (`git checkout -- <path>`, or delete an untracked file).',
		'Touch only the paths listed above. Then stop; say in one line what you did with each.',
	].join('\n');
}

// ─── Claims: edits made outside a cycle ────────────────────────────────────────
//
// A dashboard chat is a second instance of a member working in the same checkout, possibly while
// some cycle runs. It records what each of its turns changed, with the signature it left, so the
// runner doesn't hand those paths to whichever member's cycle happened to be running. A claim
// holds only while the path still carries the claimed signature: once anyone changes it again, it
// is theirs. Best effort — a cycle edit landing inside a chat turn's window reads as the chat's.


const claimsPath = (teamDir) => join(teamDir, '.logs', 'leftover-claims.json');

/** { [path]: { sig, owner } } — empty when there is no claims file yet. */
export async function readClaims(teamDir) {
	try {
		return JSON.parse(await readFile(claimsPath(teamDir), 'utf-8'));
	} catch {
		return {};
	}
}

async function writeClaims(teamDir, claims) {
	const p = claimsPath(teamDir);
	await mkdir(join(teamDir, '.logs'), { recursive: true });
	await writeFile(`${p}.tmp`, JSON.stringify(claims, null, 2));
	await rename(`${p}.tmp`, p);
}

/** Record `paths` (from `leftoversSince`) as `owner`'s, at their signatures in `snapshot`. */
export async function recordClaims(teamDir, owner, paths, snapshot) {
	if (paths.length === 0) return;
	const claims = await readClaims(teamDir);
	for (const { path } of paths) {
		const sig = snapshot.get(path);
		if (sig) claims[path] = { sig, owner };
	}
	await writeClaims(teamDir, claims);
}

/** Drop every claim `owner` holds. */
export async function releaseClaims(teamDir, owner) {
	const claims = await readClaims(teamDir);
	const kept = Object.fromEntries(Object.entries(claims).filter(([, c]) => c.owner !== owner));
	if (Object.keys(kept).length !== Object.keys(claims).length) await writeClaims(teamDir, kept);
}

/** Paths `owner` still holds: claimed, and unchanged since. [{ path, status }] */
export function heldClaims(claims, owner, snapshot) {
	return Object.entries(claims)
		.filter(([path, c]) => c.owner === owner && snapshot?.get(path) === c.sig)
		.map(([path, c]) => ({ path, status: c.sig.slice(0, 2) }));
}

/** `leftovers` minus paths someone else still holds a claim on. */
export function withoutClaimed(leftovers, claims, snapshot) {
	return leftovers.filter(({ path }) => {
		const c = claims[path];
		return !c || snapshot?.get(path) !== c.sig;
	});
}
