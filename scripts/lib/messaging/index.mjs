/**
 * @typedef {Object} Message
 * @property {string} from
 * @property {string} sentAt      - ISO-8601
 * @property {boolean} [requestResponse]
 * @property {string} [projectCode]
 * @property {string} [conversationId] - thread/group ID
 * @property {string} [replyTo]        - message being replied to
 * @property {string} body
 */

/**
 * @typedef {Object} MessagingAdapter
 * @property {(member: string) => Promise<boolean>} hasMessages
 * @property {(member: string) => Promise<Message[]>} getMessages
 * @property {(member: string, messageId: string) => Promise<void>} acknowledgeMessage
 * @property {(recipients: string[], message: Message) => Promise<void>} sendMessage
 * @property {(member: string) => Promise<Object[]>} listConversations
 * @property {() => Object[]} getMcpTools - MCP tool definitions for the agent
 */

import { FileMessagingAdapter } from './file.mjs';

/**
 * Create a messaging adapter based on configuration.
 * @param {string} adapterName - 'file' or 'discord'
 * @param {Object} config - adapter-specific configuration
 * @param {string} teamDir - path to the team directory
 * @returns {Promise<MessagingAdapter>}
 */
export async function createMessagingAdapter(adapterName, config, teamDir) {
	switch (adapterName) {
		case 'file':
			return new FileMessagingAdapter(teamDir);
		case 'discord': {
			const { DiscordMessagingAdapter } = await import('./discord.mjs');
			return new DiscordMessagingAdapter(config.discord);
		}
		default:
			throw new Error(`Unknown messaging adapter: ${adapterName}. Available: file, discord`);
	}
}
