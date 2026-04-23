/**
 * @typedef {Object} MessageSummary
 * @property {string} id
 * @property {string} from
 * @property {string[]} to
 * @property {string[]} [cc]
 * @property {string} subject
 * @property {string} sentAt
 * @property {string} [projectCode]
 * @property {boolean} hasParent
 * @property {string[]} [supersedes] — ids of prior messages this one consolidates / replaces
 * @property {string} [supersededBy] — id of a later message that consolidates / replaces this one
 */

/**
 * @typedef {Object} MessagingAdapter
 * @property {(member: string) => Promise<boolean>} hasMessages
 * @property {(args: { from: string, to: string[], cc?: string[], subject?: string, body: string, replyTo?: string, projectCode?: string }) => Promise<{ id: string, sentAt: string }>} sendMessage
 * @property {(args: { from: string, supersedes: string[], to: string[], cc?: string[], subject?: string, body: string, replyTo?: string, projectCode?: string }) => Promise<{ id: string, sentAt: string, supersededIds: string[], unreadRemoved: number, alreadyDelivered: number }>} supersedeMessage
 * @property {(id: string, opts?: { inlineParent?: boolean }) => Promise<Object>} readMessage
 * @property {(member: string) => Promise<MessageSummary[]>} listInbox
 * @property {(member: string, opts?: { to?: string[] }) => Promise<MessageSummary[]>} listSent
 * @property {(member: string) => Promise<MessageSummary[]>} listArchives
 * @property {(member: string, id: string) => Promise<void>} archiveMessage
 * @property {(member: string, id: string) => Promise<void>} unarchiveMessage
 */

import { FileMessagingAdapter } from './file.mjs';

/**
 * Create a messaging adapter based on configuration.
 * Currently only the file adapter ships; see teamos/docs/messages.md for the
 * protocol contract a future SMTP/IMAP adapter would implement.
 */
export async function createMessagingAdapter(adapterName, _config, teamDir) {
	switch (adapterName) {
		case 'file':
			return new FileMessagingAdapter(teamDir);
		default:
			throw new Error(`Unknown messaging adapter: ${adapterName}. Available: file`);
	}
}
