/**
 * Discord messaging adapter — uses Discord.js bot API.
 * This is a skeleton for Phase 3 implementation.
 *
 * Configuration:
 * {
 *   botToken: string,        // Discord bot token (from env var)
 *   guildId: string,         // Discord server/guild ID
 *   memberMap: {             // Maps team member names to Discord user IDs
 *     "alice": "discord-user-id",
 *     "bob": "discord-user-id"
 *   }
 * }
 */
export class DiscordMessagingAdapter {
	constructor(config) {
		this.config = config;
		this.botToken = config.botToken;
		this.guildId = config.guildId;
		this.memberMap = config.memberMap || {};
		this.lastReadTimestamps = {};
		// TODO: Initialize Discord.js client
		// this.client = new Client({ intents: [...] });
	}

	async hasMessages(member) {
		// TODO: Check for unread messages since last acknowledged timestamp
		console.warn('[discord] hasMessages() not yet implemented');
		return false;
	}

	async getMessages(member) {
		// TODO: Fetch messages from member's channels/DMs since last cycle
		console.warn('[discord] getMessages() not yet implemented');
		return [];
	}

	async acknowledgeMessage(member, messageId) {
		// TODO: Update the last-read timestamp
		console.warn('[discord] acknowledgeMessage() not yet implemented');
	}

	async sendMessage(recipients, message) {
		// TODO: Post to the appropriate channel or DM thread
		console.warn('[discord] sendMessage() not yet implemented');
	}

	async listConversations(member) {
		// TODO: List active conversations
		console.warn('[discord] listConversations() not yet implemented');
		return [];
	}

	getMcpTools() {
		// Same tool definitions as the file adapter — the interface is uniform
		return [
			{
				name: 'send_message',
				description: 'Send a message to one or more team members via Discord.',
				input_schema: {
					type: 'object',
					properties: {
						recipients: { type: 'array', items: { type: 'string' }, description: 'List of recipient member names' },
						body: { type: 'string', description: 'Message body (markdown)' },
						projectCode: { type: 'string', description: 'Optional project code' },
						conversationId: { type: 'string', description: 'Optional conversation/thread ID for threading' },
						replyTo: { type: 'string', description: 'Optional message ID being replied to' },
					},
					required: ['recipients', 'body'],
				},
			},
			{
				name: 'read_messages',
				description: 'Read pending messages for the current member from Discord.',
				input_schema: {
					type: 'object',
					properties: {},
				},
			},
			{
				name: 'acknowledge_message',
				description: 'Mark a Discord message as processed/read.',
				input_schema: {
					type: 'object',
					properties: {
						messageId: { type: 'string', description: 'The message ID to acknowledge' },
					},
					required: ['messageId'],
				},
			},
			{
				name: 'list_conversations',
				description: 'List active Discord conversations the member is part of.',
				input_schema: {
					type: 'object',
					properties: {},
				},
			},
		];
	}
}
