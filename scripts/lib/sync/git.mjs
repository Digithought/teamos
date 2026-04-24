import { execSync } from 'node:child_process';

/**
 * Git sync adapter — commits, pushes, and keeps the local checkout in step
 * with `origin/<branch>`.
 *
 * Sync semantics:
 *   - pull(): fetch origin, fast-forward if possible, otherwise rebase local
 *     commits (with autostash) onto origin. Rebase conflicts abort cleanly
 *     and leave local state untouched so the next push surfaces the problem.
 *   - push(): stage + commit any changes. If pushing fails non-FF, pull once
 *     and retry. A second failure is logged and left for humans to resolve.
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
			} catch (err) {
				console.error(`[sync/git] fast-forward failed: ${this._errText(err)}`);
			}
			return;
		}

		try {
			execSync(`git rebase --autostash origin/${branch}`, { cwd: workDir, stdio: 'pipe' });
			console.log(`[sync/git] rebased local commits onto origin/${branch}`);
		} catch (err) {
			console.error(`[sync/git] rebase onto origin/${branch} failed: ${this._errText(err)}`);
			try { execSync('git rebase --abort', { cwd: workDir, stdio: 'pipe' }); } catch {}
			console.error('[sync/git] left local state unchanged; the next push will fail until resolved manually.');
		}
	}

	async push(workDir, label) {
		let status;
		try {
			status = execSync('git status --porcelain', { cwd: workDir, encoding: 'utf-8' }).trim();
		} catch (err) {
			console.error(`[sync/git] status failed: ${err.message}`);
			return;
		}
		if (!status) return;

		try {
			execSync('git add -A', { cwd: workDir, encoding: 'utf-8' });
			execSync(`git commit -m "${label.replace(/"/g, '\\"')}"`, { cwd: workDir, encoding: 'utf-8' });
			console.log('  Committed.');
		} catch (err) {
			console.error(`[sync/git] commit failed: ${err.message}`);
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
