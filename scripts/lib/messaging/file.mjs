import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from '../util.mjs';

/**
 * Parse YAML-style frontmatter from a markdown message file.
 * Returns { metadata, body } where metadata is an object of key-value pairs.
 */
function parseFrontmatter(content) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) return { metadata: {}, body: content.trim() };

	const metadata = {};
	for (const line of match[1].split('\n')) {
		const colonIdx = line.indexOf(':');
		if (colonIdx > 0) {
			const key = line.slice(0, colonIdx).trim();
			const value = line.slice(colonIdx + 1).trim();
			metadata[key] = value;
		}
	}
	return { metadata, body: match[2].trim() };
}

/**
 * File-based messaging adapter — wraps the current inbox/ directory behavior.
 */
export class FileMessagingAdapter {
	constructor(teamDir) {
		this.teamDir = teamDir;
	}

	_inboxDir(member) {
		return join(this.teamDir, 'members', member, 'inbox');
	}

	async hasMessages(member) {
		const inboxDir = this._inboxDir(member);
		if (!await pathExists(inboxDir)) return false;
		try {
			const files = await readdir(inboxDir);
			return files.some(f => f.endsWith('.md'));
		} catch {
			return false;
		}
	}

	async getMessages(member) {
		const inboxDir = this._inboxDir(member);
		try {
			const files = await readdir(inboxDir);
			const mdFiles = files.filter(f => f.endsWith('.md'));
			const messages = [];
			for (const file of mdFiles) {
				const content = await readFile(join(inboxDir, file), 'utf-8').catch(() => '');
				if (!content) continue;
				const { metadata, body } = parseFrontmatter(content);
				messages.push({
					id: file,
					from: metadata.from || 'unknown',
					sentAt: metadata.sentAt || new Date().toISOString(),
					requestResponse: metadata.requestResponse === 'true',
					projectCode: metadata.projectCode || undefined,
					conversationId: metadata.conversationId || undefined,
					replyTo: metadata.replyTo || undefined,
					body,
					_raw: content,
					_file: file,
				});
			}
			return messages;
		} catch {
			return [];
		}
	}

	async acknowledgeMessage(member, messageId) {
		const filePath = join(this._inboxDir(member), messageId);
		await unlink(filePath).catch(() => {});
	}

	async sendMessage(recipients, message) {
		const timestamp = message.sentAt || new Date().toISOString();
		const slug = (message.body || 'message').toLowerCase()
			.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
		const filename = `${slug}-${Date.now()}.md`;

		const frontmatter = [
			'---',
			`from: ${message.from}`,
			`sentAt: ${timestamp}`,
		];
		if (message.requestResponse) frontmatter.push(`requestResponse: true`);
		if (message.projectCode) frontmatter.push(`projectCode: ${message.projectCode}`);
		if (message.conversationId) frontmatter.push(`conversationId: ${message.conversationId}`);
		if (message.replyTo) frontmatter.push(`replyTo: ${message.replyTo}`);
		frontmatter.push('---', '');

		const content = frontmatter.join('\n') + message.body + '\n';

		for (const recipient of recipients) {
			const inboxDir = this._inboxDir(recipient);
			await mkdir(inboxDir, { recursive: true });
			await writeFile(join(inboxDir, filename), content, 'utf-8');
		}
	}

	async listConversations(member) {
		const messages = await this.getMessages(member);
		const convMap = new Map();
		for (const msg of messages) {
			const id = msg.conversationId || msg.id;
			if (!convMap.has(id)) {
				convMap.set(id, { id, messages: [] });
			}
			convMap.get(id).messages.push(msg);
		}
		return Array.from(convMap.values());
	}

	/**
	 * Return MCP tool definitions that the agent can use during cycles.
	 * The runner passes these to the agent adapter as available tools.
	 */
	getMcpTools() {
		return [
			{
				name: 'send_message',
				description: 'Send a message to one or more team members.',
				input_schema: {
					type: 'object',
					properties: {
						recipients: { type: 'array', items: { type: 'string' }, description: 'List of recipient member names' },
						body: { type: 'string', description: 'Message body (markdown)' },
						projectCode: { type: 'string', description: 'Optional project code' },
						conversationId: { type: 'string', description: 'Optional conversation/thread ID' },
						replyTo: { type: 'string', description: 'Optional message ID being replied to' },
					},
					required: ['recipients', 'body'],
				},
			},
			{
				name: 'read_messages',
				description: 'Read pending messages for the current member.',
				input_schema: {
					type: 'object',
					properties: {},
				},
			},
			{
				name: 'acknowledge_message',
				description: 'Mark a message as processed/read.',
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
				description: 'List active conversations the member is part of.',
				input_schema: {
					type: 'object',
					properties: {},
				},
			},
		];
	}
}
