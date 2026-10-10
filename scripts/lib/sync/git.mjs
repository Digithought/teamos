import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Git sync adapter — commits, pushes, and keeps the local checkout in step
 * with `origin/<branch>`.
 *
 * Sync semantics:
 *   - pull(): fetch origin; fast-forward if local is behind, no-op if local is
 *     ahead, otherwise rebase local commits (with autostash) onto origin.
 *     Rebase conflicts abort cleanly and leave local state untouched so the
 *     next push surfaces the problem. Both the fast-forward and the rebase
 *     move the superproject's gitlinks forward without touching a submodule's
 *     own checked-out content — `submodule.recurse` isn't reliably honored by
 *     `git rebase`, and a plain `git merge --ff-only` never recurses at all —
 *     so an explicit `git submodule update --init --recursive` follows each.
 *     Skipping this left the index pointer correct but the physical
 *     `teamos/` checkout stale after a pin bump, which a later broad `git add
 *     -A` would then re-stage as an apparent pointer revert.
 *   - push(): stage + commit any changes. If pushing fails non-FF, pull once
 *     and retry. A second failure is logged and left for humans to resolve.
 *     The commit never records a submodule pin that fails to move forward:
 *     a checkout left behind its gitlink by a hand rebase, reset or pull is
 *     exactly what `git add -A` would re-record as a rewind, so any pin that
 *     is behind, diverged or of unprovable ancestry is left unstaged with a
 *     warning, and does not count as a change (`refusedPinMoves`). Submodule
 *     *content* is invisible to the status probe for the same reason: the
 *     parent cannot commit it, and counting it made every push stage nothing
 *     and fail with "nothing to commit". The same guard as tess's `commitAll`;
 *     teamos does not depend on tess, so it is a local copy.
 *
 * The adapter prefers `TEAMOS_REPO_BRANCH` for the tracking branch and falls
 * back to `git rev-parse --abbrev-ref HEAD` so it doesn't rely on upstream
 * tracking config being set.
 */
export class GitSyncAdapter {
	constructor(config = {}) {
		this.autoPush = config.push || false;
		this._branch = null;
	}

	async pull(workDir) {
		const branch = this._getBranch(workDir);
		if (!branch) return;

		if (!this._fetch(workDir, branch)) return;

		const local = this._revParse(workDir, 'HEAD');
		const remote = this._revParse(workDir, `origin/${branch}`);
		if (!local || !remote || local === remote) return;

		if (this._isAncestor(workDir, local, remote)) {
			try {
				execSync(`git merge --ff-only origin/${branch}`, { cwd: workDir, stdio: 'pipe' });
				console.log(`[sync/git] fast-forwarded ${local.slice(0, 7)}..${remote.slice(0, 7)}`);
				this._updateSubmodules(workDir);
			} catch (err) {
				console.error(`[sync/git] fast-forward failed: ${this._errText(err)}`);
			}
			return;
		}

		// Local is ahead of remote with no divergence — nothing to pull.
		if (this._isAncestor(workDir, remote, local)) return;

		try {
			execSync(`git rebase --autostash origin/${branch}`, { cwd: workDir, stdio: 'pipe' });
			console.log(`[sync/git] rebased local commits onto origin/${branch}`);
			this._updateSubmodules(workDir);
		} catch (err) {
			console.error(`[sync/git] rebase onto origin/${branch} failed: ${this._errText(err)}`);
			try {
				execSync('git rebase --abort', { cwd: workDir, stdio: 'pipe' });
			} catch {}
			console.error('[sync/git] left local state unchanged; the next push will fail until resolved manually.');
		}
	}

	async push(workDir, label) {
		// The pin guard reads `.gitmodules` and submodule paths relative to its cwd,
		// so it runs from the top level: from a subdirectory (`process.cwd()` is
		// run.mjs's fallback) it found no submodules and let the rewind through.
		let root, changed;
		try {
			root = runGit(workDir, ['rev-parse', '--show-toplevel']).trim();
			changed = changedPaths(root);
		} catch (err) {
			console.error(`[sync/git] status failed: ${this._errText(err)}`);
			return;
		}
		if (changed.length === 0) return;

		try {
			const refused = refusedPinMoves(root, changed);
			printRefusedPinNotice(refused, label);
			if (changed.every((path) => refused.some((pin) => pin.path === path))) return;

			stageAllButRefusedPins(root, refused);
			runGit(root, ['commit', '-m', label]);
			console.log('  Committed.');
		} catch (err) {
			console.error(`[sync/git] commit failed: ${this._errText(err)}`);
			return;
		}

		if (!this.autoPush) return;

		if (this._tryPush(workDir)) return;

		console.log('[sync/git] push rejected; pulling and retrying once.');
		await this.pull(workDir);
		this._tryPush(workDir);
	}

	async init() {
		// Assumes repo already exists — nothing to initialize
	}

	_tryPush(workDir) {
		try {
			execSync('git push', { cwd: workDir, encoding: 'utf-8', stdio: 'pipe' });
			console.log('  Pushed.');
			return true;
		} catch (err) {
			console.error(`[sync/git] push failed: ${this._errText(err)}`);
			return false;
		}
	}

	_updateSubmodules(workDir) {
		try {
			execSync('git submodule update --init --recursive', { cwd: workDir, stdio: 'pipe' });
		} catch (err) {
			console.error(`[sync/git] submodule update failed: ${this._errText(err)}`);
		}
	}

	_getBranch(workDir) {
		if (this._branch) return this._branch;
		const envBranch = process.env.TEAMOS_REPO_BRANCH?.trim();
		if (envBranch) {
			this._branch = envBranch;
			return envBranch;
		}
		try {
			const head = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workDir, encoding: 'utf-8' }).trim();
			if (head && head !== 'HEAD') {
				this._branch = head;
				return head;
			}
		} catch {}
		console.error('[sync/git] cannot determine branch (detached HEAD?); skipping sync.');
		return null;
	}

	_fetch(workDir, branch) {
		try {
			execSync(`git fetch origin ${branch}`, { cwd: workDir, stdio: 'pipe' });
			return true;
		} catch (err) {
			console.error(`[sync/git] fetch failed: ${this._errText(err)}`);
			return false;
		}
	}

	_revParse(workDir, ref) {
		try {
			return execSync(`git rev-parse ${ref}`, { cwd: workDir, encoding: 'utf-8' }).trim();
		} catch {
			return null;
		}
	}

	_isAncestor(workDir, ancestor, descendant) {
		try {
			execSync(`git merge-base --is-ancestor ${ancestor} ${descendant}`, { cwd: workDir, stdio: 'pipe' });
			return true;
		} catch {
			return false;
		}
	}

	_errText(err) {
		return err?.stderr?.toString().trim() || err?.message || String(err);
	}
}

/** Run git with an argv array, never a shell string: the arguments below carry
 *  submodule paths read out of `.gitmodules`, and the commit message a label. */
function runGit(cwd, args) {
	return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Paths `git status` reports as changed, ignoring submodule content. `-z`
 *  leaves paths unquoted, so they compare directly against `.gitmodules`; a
 *  rename's source path follows its destination as a separate field. */
function changedPaths(cwd) {
	const fields = runGit(cwd, ['status', '--porcelain', '-z', '--ignore-submodules=dirty']).split('\0');
	const paths = [];
	for (let i = 0; i < fields.length; i++) {
		if (fields[i].length < 4) continue;
		paths.push(fields[i].slice(3));
		if (fields[i][0] === 'R' || fields[i][0] === 'C') i++;
	}
	return paths;
}

/** Every submodule path `.gitmodules` declares. Read from there rather than a
 *  list here, because teamos serves projects with different submodule sets.
 *  `-z` because a path containing a space puts a space in the submodule name
 *  too, which would break splitting `submodule.<name>.path <path>` on one. */
function declaredSubmodulePaths(cwd) {
	let declared;
	try {
		declared = runGit(cwd, ['config', '-z', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']);
	} catch {
		return [];
	}
	const paths = [];
	for (const record of declared.split('\0')) {
		const newline = record.indexOf('\n');
		if (newline !== -1 && newline < record.length - 1) paths.push(record.slice(newline + 1));
	}
	return paths;
}

/** Gitlinks (mode 160000) in `git ls-tree -z` or `git ls-files -s -z` output,
 *  as `path → sha`; ls-tree puts the object type before the sha, ls-files the
 *  stage number after it. */
function readGitlinks(cwd, args) {
	let raw;
	try {
		raw = runGit(cwd, args);
	} catch {
		return new Map(); // an unborn HEAD records nothing to compare against
	}
	const links = new Map();
	for (const record of raw.split('\0')) {
		const match = /^160000 (?:commit )?([0-9a-f]+)(?: \d+)?\t([^]+)$/.exec(record);
		if (match) links.set(match[2], match[1]);
	}
	return links;
}

/** Whether commit `a` is an ancestor of `b` in the submodule at `path`; null
 *  when git cannot say, which is what a commit missing from its object store looks like. */
function isAncestorIn(cwd, path, a, b) {
	try {
		runGit(cwd, ['-C', path, 'merge-base', '--is-ancestor', a, b]);
		return true;
	} catch (err) {
		return err.status === 1 ? false : null;
	}
}

/** 'forward' | 'behind' | 'diverged' | 'unknown', for a checked-out submodule. */
function pinRelation(cwd, path, recorded, actual) {
	const forward = isAncestorIn(cwd, path, recorded, actual);
	if (forward === true) return 'forward';
	const behind = forward === null ? null : isAncestorIn(cwd, path, actual, recorded);
	if (behind === null) return 'unknown';
	return behind ? 'behind' : 'diverged';
}

function checkoutHead(cwd, path) {
	try {
		return runGit(cwd, ['-C', path, 'rev-parse', '--verify', '-q', 'HEAD']).trim() || null;
	} catch {
		return null; // a submodule repo with no commits yet
	}
}

/**
 * The changed submodule pins a commit must not record: each one whose new pin
 * does not descend from the pin in HEAD. Returns
 * `[{ path, recorded, actual, relation, checkedOut }]`; forward moves, and
 * submodules HEAD does not record yet, commit like any other change.
 *
 * `actual` is what `git add -A` would record: the checkout's HEAD, or — for a
 * submodule that is not checked out, which `git add -A` leaves alone —
 * whatever gitlink is already staged. Nothing in that empty directory can prove
 * a staged pin's ancestry, so it reads as 'unknown'. The checked-out test
 * comes first because `git -C` on an empty directory walks up and answers for
 * the parent repo instead.
 */
function refusedPinMoves(cwd, changed) {
	const paths = declaredSubmodulePaths(cwd).filter((path) => changed.includes(path));
	if (paths.length === 0) return [];

	const recorded = readGitlinks(cwd, ['ls-tree', '-z', 'HEAD', '--', ...paths]);
	const staged = readGitlinks(cwd, ['ls-files', '-s', '-z', '--', ...paths]);
	const refused = [];
	for (const path of paths) {
		const was = recorded.get(path);
		if (!was) continue;
		const checkedOut = existsSync(resolve(cwd, path, '.git'));
		const now = checkedOut ? checkoutHead(cwd, path) : staged.get(path);
		if (!now || now === was) continue;
		const relation = checkedOut ? pinRelation(cwd, path, was, now) : 'unknown';
		if (relation !== 'forward') refused.push({ path, recorded: was, actual: now, relation, checkedOut });
	}
	return refused;
}

/** `git add -A`, minus the refused pins. The exclude pathspec only stops this
 *  call staging them, so a refused gitlink already in the index is put back to
 *  HEAD's pin there. Index-only: nothing inside a submodule is checked out,
 *  reset or updated, because the older checkout may be there on purpose. */
function stageAllButRefusedPins(cwd, refused) {
	if (refused.length === 0) {
		runGit(cwd, ['add', '-A']);
		return;
	}
	const paths = refused.map((pin) => pin.path);
	runGit(cwd, ['add', '-A', '--', ':/', ...paths.map((path) => `:(exclude,literal)${path}`)]);
	const staged = readGitlinks(cwd, ['ls-files', '-s', '-z', '--', ...paths]);
	const restore = refused.filter((pin) => staged.get(pin.path) !== pin.recorded);
	if (restore.length > 0) runGit(cwd, ['reset', '-q', '--', ...restore.map((pin) => `:(literal)${pin.path}`)]);
}

const RELATION_TEXT = {
	behind: 'behind: an ancestor of the recorded pin',
	diverged: 'diverged: neither commit descends from the other',
	unknown: 'unknown: ancestry cannot be shown (a commit is missing from the submodule, or it is not checked out)',
};

/** Worded close to tess's refused-pin notice so an operator recognises it. */
function printRefusedPinNotice(refused, label) {
	if (refused.length === 0) return;
	console.error(`[sync/git] WARNING: not committing ${refused.length} submodule pin(s) that would move backwards or sideways (${label}):`);
	for (const pin of refused) {
		const where = pin.checkedOut ? 'checked out' : 'staged';
		console.error(`[sync/git]   ${pin.path}: HEAD records ${pin.recorded.slice(0, 9)}, ${where} is ${pin.actual.slice(0, 9)} — ${RELATION_TEXT[pin.relation]}`);
	}
	console.error('[sync/git]   Recording that would drop submodule commits the parent already points at, so the pin');
	console.error('[sync/git]   stays as HEAD has it and `git status` keeps showing the path modified.  If the checkout');
	console.error('[sync/git]   is simply stale, bring it up to the recorded pin:');
	for (const pin of refused) {
		console.error(`[sync/git]     git submodule update ${pin.path}`);
	}
	console.error('[sync/git]   If the rewind is intended, commit it by hand with the trailer your CI\'s pin check');
	console.error('[sync/git]   accepts (e.g. `Lamina-rewind: <reason>`).');
}
