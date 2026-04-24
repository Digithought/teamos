/**
 * @typedef {Object} CommitTrigger
 * @property {string} id
 * @property {'pressing'|'today'|'thisWeek'|'later'} priority
 * @property {string} [reason]
 * @property {string[]} [paths]          — glob patterns (`**`, `*`, `?`); any match counts
 * @property {string} [authorNot]        — skip commits by this author name or email
 * @property {string} [author]           — only commits by this author name or email
 * @property {string} [messageMatches]   — JS regex (string form) tested against commit subject
 */

/**
 * @typedef {Object} CommitMatch
 * @property {string} hash
 * @property {string} shortHash
 * @property {string} author
 * @property {string} email
 * @property {string} subject
 * @property {string[]} files            — files that changed in the commit
 * @property {string[]} matchedTriggerIds
 * @property {'pressing'|'today'|'thisWeek'|'later'} priority — highest priority across matched triggers
 */

/**
 * @typedef {Object} TriggersAdapter
 * @property {(member: string) => Promise<CommitTrigger[]>} listTriggers
 * @property {(member: string, input: Omit<CommitTrigger, 'id'>) => Promise<{ id: string }>} addTrigger
 * @property {(member: string, id: string, patch: Partial<Omit<CommitTrigger, 'id'>>) => Promise<void>} updateTrigger
 * @property {(member: string, id: string) => Promise<void>} removeTrigger
 * @property {(member: string) => Promise<CommitMatch[]>} pendingMatches
 * @property {(member: string, priority: string) => Promise<boolean>} hasPendingMatches
 * @property {(member: string) => Promise<string | null>} currentHead
 * @property {(member: string, head: string) => Promise<void>} acknowledgeHead
 */

import { FileTriggersAdapter } from './file.mjs';

/**
 * Create a triggers adapter based on configuration.
 *
 * Currently only the file adapter ships; see teamos/docs/triggers.md for the
 * MCP contract future adapters would implement.
 */
export async function createTriggersAdapter(adapterName, _config, teamDir, repoRoot) {
	switch (adapterName) {
		case 'file':
			return new FileTriggersAdapter(teamDir, repoRoot);
		default:
			throw new Error(`Unknown triggers adapter: ${adapterName}. Available: file`);
	}
}
