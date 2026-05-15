#!/usr/bin/env node
/**
 * MCP server for TeamOS agent tools.
 *
 * Implements the Model Context Protocol over stdio (JSON-RPC 2.0) so that
 * agents (Claude CLI) can send/read messages, manage their todo list, and
 * maintain their schedule through the file-backed adapters. The messaging
 * tool contract matches teamos/docs/messages.md; the task tool contract
 * matches teamos/docs/tasks.md; the schedule tool contract matches
 * teamos/docs/schedule.md.
 *
 * Environment variables (all optional):
 *   TEAMOS_TEAM_DIR          — path to the team/ directory (default: <cwd>/team)
 *   TEAMOS_MEMBER_NAME       — default member identity when a tool call omits `member`
 *   TEAMOS_MESSAGING_ADAPTER — messaging adapter name (default: file)
 *   TEAMOS_TASKS_ADAPTER     — tasks adapter name     (default: file)
 *   TEAMOS_SCHEDULE_ADAPTER  — schedule adapter name  (default: file)
 *   TEAMOS_TRIGGERS_ADAPTER  — commit-triggers adapter name (default: file)
 *
 * Every tool accepts an optional `member` argument identifying the team member
 * whose mailbox / todos / schedule / triggers the call operates against. When
 * omitted, the server falls back to `TEAMOS_MEMBER_NAME`. This makes the same
 * server process usable by any member — the runner sets the env var per-cycle
 * so existing agent behavior is unchanged, while interactive sessions can act
 * as any member by passing `member` explicitly.
 */

import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { FileScheduleAdapter } from '../schedule/file.mjs';
import { FileTasksAdapter } from '../tasks/file.mjs';
import { FileTriggersAdapter } from '../triggers/file.mjs';
import { FileMessagingAdapter } from './file.mjs';

// ─── Resolve adapters from env ─────────────────────────────────────────────────

const teamDir = process.env.TEAMOS_TEAM_DIR || join(process.cwd(), 'team');
const envMemberName = process.env.TEAMOS_MEMBER_NAME || null;

function resolveMember(args) {
	const name = (args && args.member) || envMemberName;
	if (!name) {
		throw {
			code: -32602,
			message:
				'Missing member identity: pass `member: "<name>"` in the tool call or set TEAMOS_MEMBER_NAME in the environment.',
		};
	}
	return name;
}

const messagingAdapterName = process.env.TEAMOS_MESSAGING_ADAPTER || 'file';
const tasksAdapterName = process.env.TEAMOS_TASKS_ADAPTER || 'file';
const scheduleAdapterName = process.env.TEAMOS_SCHEDULE_ADAPTER || 'file';
const triggersAdapterName = process.env.TEAMOS_TRIGGERS_ADAPTER || 'file';

// The triggers adapter runs `git` in the repo root. The team dir is always
// team/ under the repo, so repoRoot is its parent.
const repoRoot = join(teamDir, '..');

function makeMessagingAdapter(name) {
	switch (name) {
		case 'file':
			return new FileMessagingAdapter(teamDir);
		default:
			process.stderr.write(`[mcp-server] Unknown messaging adapter: ${name}\n`);
			process.exit(1);
	}
}

function makeTasksAdapter(name) {
	switch (name) {
		case 'file':
			return new FileTasksAdapter(teamDir);
		default:
			process.stderr.write(`[mcp-server] Unknown tasks adapter: ${name}\n`);
			process.exit(1);
	}
}

function makeScheduleAdapter(name) {
	switch (name) {
		case 'file':
			return new FileScheduleAdapter(teamDir);
		default:
			process.stderr.write(`[mcp-server] Unknown schedule adapter: ${name}\n`);
			process.exit(1);
	}
}

function makeTriggersAdapter(name) {
	switch (name) {
		case 'file':
			return new FileTriggersAdapter(teamDir, repoRoot);
		default:
			process.stderr.write(`[mcp-server] Unknown triggers adapter: ${name}\n`);
			process.exit(1);
	}
}

const adapter = makeMessagingAdapter(messagingAdapterName);
const tasks = makeTasksAdapter(tasksAdapterName);
const schedule = makeScheduleAdapter(scheduleAdapterName);
const triggers = makeTriggersAdapter(triggersAdapterName);

// ─── Tool definitions ──────────────────────────────────────────────────────────

// Every tool's inputSchema is augmented with an optional `member` field at
// module load (see TOOLS below). The handler resolves the active member via
// resolveMember(args), falling back to TEAMOS_MEMBER_NAME when omitted, so
// tool definitions below stay focused on tool-specific arguments.
const MEMBER_PROP = {
	type: 'string',
	description: 'Member identity (defaults to the runner-set member).',
};

const BASE_TOOLS = [
	{
		name: 'send_message',
		description:
			'Send a message to one or more team members. Behaves like email: targets multiple parties, carries a subject, can reference a preceding message via replyTo. Cost scales with length × recipients — keep messages tight, especially on broad threads. Before composing to a recipient set you have already messaged this cycle, call list_sent({ to: [...] }) and prefer supersede_message to consolidate over stacking another message on the same topic.',
		inputSchema: {
			type: 'object',
			properties: {
				to: { type: 'array', items: { type: 'string' }, description: 'Primary recipient member names' },
				subject: {
					type: 'string',
					description:
						'Thread subject (required on new threads; auto-derived as "Re: <parent>" for replies if omitted)',
				},
				body: { type: 'string', description: 'Message body (markdown)' },
				cc: { type: 'array', items: { type: 'string' }, description: "Optional cc'd member names" },
				replyTo: { type: 'string', description: 'Optional id of the message being replied to' },
				projectCode: { type: 'string', description: 'Optional project tag for filtering/grouping' },
			},
			required: ['to', 'body'],
		},
	},
	{
		name: 'supersede_message',
		description:
			'Send a new message that consolidates / replaces one or more earlier messages YOU sent. The consolidated message is delivered normally; each predecessor is marked supersededBy and silently removed from any recipient inbox where it had not yet been read. Recipients who already archived the predecessor keep it (audit trail preserved) and see the new message arrive separately. Use this when you have more to say to the same audience on the same topic — it is strictly better than sending an additional message. The new recipient set (to + cc) must cover every recipient any predecessor reached; to address a smaller audience send a regular message instead.',
		inputSchema: {
			type: 'object',
			properties: {
				supersedes: {
					type: 'array',
					items: { type: 'string' },
					description:
						'Ids of one or more prior messages you sent that this message replaces. All predecessors must be from you and not already superseded.',
				},
				to: {
					type: 'array',
					items: { type: 'string' },
					description: 'Primary recipient member names. Must cover every recipient any predecessor reached.',
				},
				body: {
					type: 'string',
					description:
						'Message body (markdown). Treat this as the standalone replacement — no need to repeat predecessor wording verbatim.',
				},
				subject: { type: 'string', description: 'Thread subject. If omitted, derived from the latest predecessor.' },
				cc: { type: 'array', items: { type: 'string' }, description: "Optional cc'd member names." },
				replyTo: {
					type: 'string',
					description:
						'Optional id of the message this thread replies to (carries through to the new message; usually omit).',
				},
				projectCode: { type: 'string', description: 'Optional project tag.' },
			},
			required: ['supersedes', 'to', 'body'],
		},
	},
	{
		name: 'read_message',
		description:
			'Read a message by id from the master store. Returns the full message; when replyTo is set, the immediate parent is inlined as `parent` (one hop). To walk further back, call read_message again with parent.replyTo.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The message id' },
			},
			required: ['id'],
		},
	},
	{
		name: 'list_inbox',
		description: 'List summaries for every message in your inbox (newest first).',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'list_sent',
		description:
			'List summaries for every message you have sent (newest first). Pass `to: [<member>, ...]` to filter to messages whose to+cc intersects that member set — use this before composing to recipients you have already messaged this cycle, so you can spot threads that should be consolidated via supersede_message instead of stacked.',
		inputSchema: {
			type: 'object',
			properties: {
				to: {
					type: 'array',
					items: { type: 'string' },
					description:
						'Optional recipient filter — only return sent messages whose to+cc includes at least one of these members.',
				},
			},
		},
	},
	{
		name: 'list_archives',
		description: 'List summaries for every message you have archived (newest first).',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'archive_message',
		description:
			'Move a message from your inbox to your archives. Call this after you have fully handled a message. No-op if already archived; errors if the id is not in your inbox.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The message id to archive' },
			},
			required: ['id'],
		},
	},
	{
		name: 'unarchive_message',
		description: 'Inverse of archive_message — move a message from your archives back to your inbox.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The message id to unarchive' },
			},
			required: ['id'],
		},
	},
	{
		name: 'list_todos',
		description:
			'List every open todo on your list, priority order (pressing → later). Blocked items appear after actionable ones within each priority. The cycle prompt already includes your todos — call this when you want a fresh view after several mutations.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'add_todo',
		description:
			'Add a new todo to your list. Returns the allocated id. Pick the priority that matches how the runner should cycle you for this item: pressing / today / thisWeek / later. Mislabelling wastes your cycles.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'One-line summary' },
				priority: {
					type: 'string',
					enum: ['pressing', 'today', 'thisWeek', 'later'],
					description: 'Scheduling priority',
				},
				description: { type: 'string', description: 'Longer body — rationale, acceptance criteria, links' },
				notes: { type: 'string', description: 'Free-form context, blockers, or progress' },
				projectCode: { type: 'string', description: 'Optional project tag' },
				status: { type: 'string', enum: ['blocked'], description: 'Rare — usually added unblocked and blocked later' },
			},
			required: ['title', 'priority'],
		},
	},
	{
		name: 'update_todo',
		description:
			'Partial update of a todo. Only supplied fields change. Use this to demote a priority, record progress in notes, or block/unblock an item. Pass status: "blocked" to mark blocked, status: null to clear it.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The todo id' },
				title: { type: 'string' },
				description: { type: 'string' },
				priority: { type: 'string', enum: ['pressing', 'today', 'thisWeek', 'later'] },
				notes: { type: 'string' },
				projectCode: { type: 'string' },
				status: { type: ['string', 'null'], enum: ['blocked', null], description: 'Set to "blocked" or null to clear' },
			},
			required: ['id'],
		},
	},
	{
		name: 'complete_todo',
		description:
			'Remove a todo from your list — there is no "done" state. History belongs in state.md or commit messages. Errors if the id is not on your list.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The todo id to complete' },
			},
			required: ['id'],
		},
	},
	{
		name: 'list_events',
		description:
			'List every event on your schedule (sorted by time ascending). Each entry includes an `isDue` flag so you can see at a glance what is firing this cycle. The cycle prompt already includes your due and upcoming events — call this when you want a fresh view after several mutations.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'add_event',
		description:
			'Add a new event to your schedule. For recurring events, `time` is the first occurrence — the runner handles advancement automatically; never bump `time` yourself. Returns the allocated id.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'One-line summary' },
				time: { type: 'string', description: 'ISO-8601 timestamp of the first occurrence' },
				description: { type: 'string', description: 'Longer body — what to do when this fires, links to rules, etc.' },
				recurrence: {
					type: 'object',
					description: 'Optional recurrence descriptor. Absent means one-time.',
					properties: {
						frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
						interval: { type: 'integer', minimum: 1, description: 'Every N days/weeks/months' },
						endDate: { type: 'string', description: 'Optional ISO-8601 cutoff; the event is removed after this point' },
					},
					required: ['frequency', 'interval'],
				},
				projectCode: { type: 'string', description: 'Optional project tag for filtering/grouping' },
			},
			required: ['title', 'time'],
		},
	},
	{
		name: 'update_event',
		description:
			'Partial update of an event. Only supplied fields change. Setting `recurrence` to null converts a recurring event into a one-time event at its current `time`. Passing a new `time` resets the next occurrence; for recurring events the adapter continues to advance from the new anchor.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The event id' },
				title: { type: 'string' },
				description: { type: 'string' },
				time: { type: 'string', description: 'ISO-8601 timestamp' },
				recurrence: {
					description: 'Recurrence descriptor, or null to clear.',
					oneOf: [
						{ type: 'null' },
						{
							type: 'object',
							properties: {
								frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
								interval: { type: 'integer', minimum: 1 },
								endDate: { type: 'string' },
							},
							required: ['frequency', 'interval'],
						},
					],
				},
				projectCode: { type: 'string' },
			},
			required: ['id'],
		},
	},
	{
		name: 'remove_event',
		description:
			'Delete an event entirely, including cancelling all future occurrences of a recurring event. Use this only for cancellations or truly unneeded events — for one-time events that have fired, the runner removes them automatically.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The event id to remove' },
			},
			required: ['id'],
		},
	},
	{
		name: 'list_triggers',
		description:
			'List every commit trigger on your subscription list. Each trigger causes new git commits matching its filters to wake you at the declared priority for review. The cycle prompt already lists any commits that fired — call this to audit your subscriptions.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'add_trigger',
		description:
			'Subscribe yourself to new commits in the host repo that match these filters. Use this for code reviews, security sweeps, or watching areas of the codebase you own. Every field other than priority is a filter — a commit must satisfy ALL provided filters to match. Commits authored by you are skipped by default (override by setting explicit `author` or explicit empty `authorNot`).',
		inputSchema: {
			type: 'object',
			properties: {
				priority: {
					type: 'string',
					enum: ['pressing', 'today', 'thisWeek', 'later'],
					description: 'Priority at which a matching commit wakes you',
				},
				reason: {
					type: 'string',
					description: 'Short note on why you created this trigger (appears when you list_triggers).',
				},
				paths: {
					type: 'array',
					items: { type: 'string' },
					description:
						'Glob patterns (`**`, `*`, `?`); match if the commit touches any file matching any glob. Omit to match any path.',
				},
				author: { type: 'string', description: 'Only match commits whose author name or email equals this.' },
				authorNot: {
					type: 'string',
					description: 'Skip commits by this author name or email. Defaults to yourself; set explicitly to override.',
				},
				messageMatches: {
					type: 'string',
					description: 'JS regex tested against the commit subject (first line of the message).',
				},
			},
			required: ['priority'],
		},
	},
	{
		name: 'update_trigger',
		description:
			'Partial update of a trigger by id. Only supplied fields change. Pass null for an optional field to clear it.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The trigger id' },
				priority: { type: 'string', enum: ['pressing', 'today', 'thisWeek', 'later'] },
				reason: { type: ['string', 'null'] },
				paths: { type: ['array', 'null'], items: { type: 'string' } },
				author: { type: ['string', 'null'] },
				authorNot: { type: ['string', 'null'] },
				messageMatches: { type: ['string', 'null'] },
			},
			required: ['id'],
		},
	},
	{
		name: 'remove_trigger',
		description: 'Unsubscribe by removing a trigger entirely.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The trigger id to remove' },
			},
			required: ['id'],
		},
	},
];

// Inject the optional `member` field into every tool's input schema. Kept out
// of the per-tool definitions so the schemas above stay legible.
const TOOLS = BASE_TOOLS.map((tool) => ({
	...tool,
	inputSchema: {
		...tool.inputSchema,
		properties: { member: MEMBER_PROP, ...(tool.inputSchema.properties || {}) },
	},
}));

// ─── Tool handlers ─────────────────────────────────────────────────────────────

function textResult(payload) {
	const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
	return { content: [{ type: 'text', text }] };
}

async function handleToolCall(name, args) {
	switch (name) {
		case 'send_message': {
			const { to, subject, body, cc, replyTo, projectCode } = args;
			const { id, sentAt } = await adapter.sendMessage({
				from: resolveMember(args),
				to,
				cc,
				subject,
				body,
				replyTo,
				projectCode,
			});
			return textResult({ id, sentAt, to, cc: cc ?? [] });
		}

		case 'supersede_message': {
			const { supersedes, to, subject, body, cc, replyTo, projectCode } = args;
			const result = await adapter.supersedeMessage({
				from: resolveMember(args),
				supersedes,
				to,
				cc,
				subject,
				body,
				replyTo,
				projectCode,
			});
			return textResult(result);
		}

		case 'read_message': {
			const { id } = args;
			const msg = await adapter.readMessage(id, { inlineParent: true });
			return textResult(msg);
		}

		case 'list_inbox':
			return textResult(await adapter.listInbox(resolveMember(args)));

		case 'list_sent':
			return textResult(await adapter.listSent(resolveMember(args), { to: args.to }));

		case 'list_archives':
			return textResult(await adapter.listArchives(resolveMember(args)));

		case 'archive_message': {
			const { id } = args;
			await adapter.archiveMessage(resolveMember(args), id);
			return textResult(`Archived ${id}`);
		}

		case 'unarchive_message': {
			const { id } = args;
			await adapter.unarchiveMessage(resolveMember(args), id);
			return textResult(`Unarchived ${id}`);
		}

		case 'list_todos':
			return textResult(await tasks.listTodos(resolveMember(args)));

		case 'add_todo': {
			const { title, priority, description, notes, projectCode, status } = args;
			const { id } = await tasks.addTodo(resolveMember(args), { title, priority, description, notes, projectCode, status });
			return textResult({ id });
		}

		case 'update_todo': {
			const { id, member: _m, ...patch } = args;
			await tasks.updateTodo(resolveMember(args), id, patch);
			return textResult(`Updated ${id}`);
		}

		case 'complete_todo': {
			const { id } = args;
			await tasks.completeTodo(resolveMember(args), id);
			return textResult(`Completed ${id}`);
		}

		case 'list_events':
			return textResult(await schedule.listEvents(resolveMember(args)));

		case 'add_event': {
			const { title, time, description, recurrence, projectCode } = args;
			const { id } = await schedule.addEvent(resolveMember(args), { title, time, description, recurrence, projectCode });
			return textResult({ id });
		}

		case 'update_event': {
			const { id, member: _m, ...patch } = args;
			await schedule.updateEvent(resolveMember(args), id, patch);
			return textResult(`Updated ${id}`);
		}

		case 'remove_event': {
			const { id } = args;
			await schedule.removeEvent(resolveMember(args), id);
			return textResult(`Removed ${id}`);
		}

		case 'list_triggers':
			return textResult(await triggers.listTriggers(resolveMember(args)));

		case 'add_trigger': {
			const { priority, reason, paths, author, authorNot, messageMatches } = args;
			const { id } = await triggers.addTrigger(resolveMember(args), {
				priority,
				reason,
				paths,
				author,
				authorNot,
				messageMatches,
			});
			return textResult({ id });
		}

		case 'update_trigger': {
			const { id, member: _m, ...patch } = args;
			await triggers.updateTrigger(resolveMember(args), id, patch);
			return textResult(`Updated ${id}`);
		}

		case 'remove_trigger': {
			const { id } = args;
			await triggers.removeTrigger(resolveMember(args), id);
			return textResult(`Removed ${id}`);
		}

		default:
			throw { code: -32601, message: `Unknown tool: ${name}` };
	}
}

// ─── JSON-RPC / MCP protocol ──────────────────────────────────────────────────

function sendResponse(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id, code, message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handleMessage(message) {
	const { id, method, params } = message;

	switch (method) {
		case 'initialize':
			sendResponse(id, {
				protocolVersion: '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'teamos-tools', version: '2.2.0' },
			});
			break;

		case 'notifications/initialized':
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
			if (id != null) sendError(id, -32601, `Method not found: ${method}`);
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

process.stderr.write(
	`[mcp-server] Started (default member=${envMemberName ?? '<unset — supply `member` in tool calls>'})\n`,
);
