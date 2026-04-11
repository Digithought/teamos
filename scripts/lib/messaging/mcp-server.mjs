#!/usr/bin/env node
/**
 * Minimal MCP server for TeamOS messaging tools.
 *
 * Implements the Model Context Protocol over stdio (JSON-RPC 2.0)
 * so that agents (Claude CLI) can send/read messages through the
 * active messaging adapter.
 *
 * Environment variables:
 *   TEAMOS_TEAM_DIR       — path to the team/ directory
 *   TEAMOS_MEMBER_NAME    — the member this cycle is running for
 *   TEAMOS_MESSAGING_ADAPTER — 'file' or 'discord'
 *   TEAMOS_DISCORD_CONFIG — JSON string of discord config (if adapter=discord)
 */

import { createInterface } from 'node:readline';
import { FileMessagingAdapter } from './file.mjs';

// ─── Resolve adapter from env ──────────────────────────────────────────────────

const teamDir = process.env.TEAMOS_TEAM_DIR;
const memberName = process.env.TEAMOS_MEMBER_NAME;
const adapterName = process.env.TEAMOS_MESSAGING_ADAPTER || 'file';

if (!teamDir || !memberName) {
	process.stderr.write('[mcp-server] Missing TEAMOS_TEAM_DIR or TEAMOS_MEMBER_NAME\n');
	process.exit(1);
}

let adapter;
if (adapterName === 'file') {
	adapter = new FileMessagingAdapter(teamDir);
} else if (adapterName === 'discord') {
	const configStr = process.env.TEAMOS_DISCORD_CONFIG;
	if (configStr) {
		const { DiscordMessagingAdapter } = await import('./discord.mjs');
		adapter = new DiscordMessagingAdapter(JSON.parse(configStr));
	} else {
		process.stderr.write('[mcp-server] Discord adapter requires TEAMOS_DISCORD_CONFIG\n');
		process.exit(1);
	}
} else {
	process.stderr.write(`[mcp-server] Unknown adapter: ${adapterName}\n`);
	process.exit(1);
}

// ─── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
	{
		name: 'send_message',
		description: 'Send a message to one or more team members. The message will be delivered to their inbox.',
		inputSchema: {
			type: 'object',
			properties: {
				recipients: { type: 'array', items: { type: 'string' }, description: 'List of recipient member names' },
				body: { type: 'string', description: 'Message body (markdown)' },
				projectCode: { type: 'string', description: 'Optional project code to associate with the message' },
				conversationId: { type: 'string', description: 'Optional conversation/thread ID for grouping' },
				replyTo: { type: 'string', description: 'Optional message ID being replied to' },
			},
			required: ['recipients', 'body'],
		},
	},
	{
		name: 'read_messages',
		description: 'Read all pending messages in your inbox. Returns an array of messages with metadata.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},
	{
		name: 'acknowledge_message',
		description: 'Mark a message as processed and remove it from your inbox. Call this after you have handled a message.',
		inputSchema: {
			type: 'object',
			properties: {
				messageId: { type: 'string', description: 'The message ID (filename) to acknowledge' },
			},
			required: ['messageId'],
		},
	},
	{
		name: 'list_conversations',
		description: 'List active conversations you are part of, grouped by conversation ID.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},
];

// ─── Tool handlers ─────────────────────────────────────────────────────────────

async function handleToolCall(name, args) {
	switch (name) {
		case 'send_message': {
			const { recipients, body, projectCode, conversationId, replyTo } = args;
			await adapter.sendMessage(recipients, {
				from: memberName,
				sentAt: new Date().toISOString(),
				body,
				projectCode,
				conversationId,
				replyTo,
			});
			return { content: [{ type: 'text', text: `Message sent to: ${recipients.join(', ')}` }] };
		}

		case 'read_messages': {
			const messages = await adapter.getMessages(memberName);
			if (messages.length === 0) {
				return { content: [{ type: 'text', text: 'No pending messages.' }] };
			}
			const formatted = messages.map(m => ({
				id: m.id || m._file,
				from: m.from,
				sentAt: m.sentAt,
				projectCode: m.projectCode,
				conversationId: m.conversationId,
				body: m.body,
			}));
			return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
		}

		case 'acknowledge_message': {
			const { messageId } = args;
			await adapter.acknowledgeMessage(memberName, messageId);
			return { content: [{ type: 'text', text: `Message ${messageId} acknowledged.` }] };
		}

		case 'list_conversations': {
			const conversations = await adapter.listConversations(memberName);
			if (conversations.length === 0) {
				return { content: [{ type: 'text', text: 'No active conversations.' }] };
			}
			return { content: [{ type: 'text', text: JSON.stringify(conversations, null, 2) }] };
		}

		default:
			throw { code: -32601, message: `Unknown tool: ${name}` };
	}
}

// ─── JSON-RPC / MCP protocol ──────────────────────────────────────────────────

function sendResponse(id, result) {
	const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
	process.stdout.write(msg + '\n');
}

function sendError(id, code, message) {
	const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
	process.stdout.write(msg + '\n');
}

function sendNotification(method, params) {
	const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
	process.stdout.write(msg + '\n');
}

async function handleMessage(message) {
	const { id, method, params } = message;

	switch (method) {
		case 'initialize':
			sendResponse(id, {
				protocolVersion: '2024-11-05',
				capabilities: {
					tools: {},
				},
				serverInfo: {
					name: 'teamos-messaging',
					version: '1.0.0',
				},
			});
			break;

		case 'notifications/initialized':
			// Client acknowledged initialization — nothing to do
			break;

		case 'tools/list':
			sendResponse(id, { tools: TOOLS });
			break;

		case 'tools/call': {
			const { name, arguments: args } = params;
			try {
				const result = await handleToolCall(name, args || {});
				sendResponse(id, result);
			} catch (err) {
				if (err.code) {
					sendError(id, err.code, err.message);
				} else {
					sendResponse(id, {
						content: [{ type: 'text', text: `Error: ${err.message}` }],
						isError: true,
					});
				}
			}
			break;
		}

		case 'ping':
			sendResponse(id, {});
			break;

		default:
			if (id != null) {
				sendError(id, -32601, `Method not found: ${method}`);
			}
			// Ignore unknown notifications (no id)
			break;
	}
}

// ─── Stdio transport ───────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
	if (!line.trim()) return;
	try {
		const message = JSON.parse(line);
		await handleMessage(message);
	} catch (err) {
		process.stderr.write(`[mcp-server] Parse error: ${err.message}\n`);
		sendError(null, -32700, 'Parse error');
	}
});

rl.on('close', () => {
	process.exit(0);
});

process.stderr.write(`[mcp-server] Started for member=${memberName} adapter=${adapterName}\n`);
