import { execSync } from 'node:child_process';

/**
 * Git sync adapter — wraps the current git add/commit/push behavior.
 */
export class GitSyncAdapter {
	/**
	 * @param {Object} config
	 * @param {boolean} [config.push] - Whether to push after commit
	 */
	constructor(config = {}) {
		this.autoPush = config.push || false;
	}

	/**
	 * Pull latest state — no-op for git (local repo is always current).
	 */
	async pull(_workDir) {
		// Local repo is always current — nothing to pull
	}

	/**
	 * Stage and commit all changes, optionally push.
	 * @param {string} workDir - The repository root directory
	 * @param {string} label - Commit message
	 */
	async push(workDir, label) {
		try {
			const status = execSync('git status --porcelain', { cwd: workDir, encoding: 'utf-8' }).trim();
			if (!status) return; // nothing to commit

			execSync('git add -A', { cwd: workDir, encoding: 'utf-8' });
			execSync(`git commit -m "${label}"`, { cwd: workDir, encoding: 'utf-8' });
			console.log('  Committed.');

			if (this.autoPush) {
				this._push(workDir);
			}
		} catch (err) {
			console.error(`[runner] Git commit failed: ${err.message}`);
		}
	}

	/**
	 * Push to the remote tracking branch.
	 */
	_push(workDir) {
		try {
			execSync('git push', { cwd: workDir, encoding: 'utf-8', stdio: 'pipe' });
			console.log('  Pushed.');
		} catch (err) {
			console.error(`[runner] Git push failed: ${err.stderr || err.message}`);
		}
	}

	/**
	 * One-time setup — no-op for git (assumes repo already exists).
	 */
	async init() {
		// Assumes repo already exists — nothing to initialize
	}
}
