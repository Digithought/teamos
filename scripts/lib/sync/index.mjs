/**
 * @typedef {Object} SyncAdapter
 * @property {(workDir: string) => Promise<void>} pull - pull latest state to local working dir
 * @property {(workDir: string, label: string) => Promise<void>} push - push local changes with label
 * @property {() => Promise<void>} init - one-time setup (create bucket, init repo, etc.)
 */

import { GitSyncAdapter } from './git.mjs';

/**
 * Create a sync adapter based on configuration.
 * @param {string} adapterName - 'git' or 's3'
 * @param {Object} config - adapter-specific configuration
 * @returns {Promise<SyncAdapter>}
 */
export async function createSyncAdapter(adapterName, config) {
	switch (adapterName) {
		case 'git':
			return new GitSyncAdapter(config.git || {});
		case 's3': {
			const { S3SyncAdapter } = await import('./s3.mjs');
			return new S3SyncAdapter(config.s3 || {});
		}
		default:
			throw new Error(`Unknown sync adapter: ${adapterName}. Available: git, s3`);
	}
}
