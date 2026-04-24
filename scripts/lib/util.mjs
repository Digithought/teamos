import { readFile, access, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';

export const STOP_FILE = '.stop';
export const PAUSE_FILE = '.pause';
const PAUSE_POLL_MS = 30 * 1000;

export async function pathExists(filePath) {
	try { await access(filePath, constants.R_OK); return true; } catch { return false; }
}

export async function readTextOrEmpty(filePath) {
	try { return await readFile(filePath, 'utf-8'); } catch { return ''; }
}

export async function checkStop(teamDir) {
	const stopFile = join(teamDir, STOP_FILE);
	if (await pathExists(stopFile)) {
		await unlink(stopFile).catch(() => {});
		return true;
	}
	return false;
}

export async function checkPause(teamDir) {
	return pathExists(join(teamDir, PAUSE_FILE));
}

/**
 * Block until `team/.pause` is removed. Returns 'stop' if `.stop` appears
 * while paused (callers should bail), otherwise 'ok'. Logs once on entering
 * pause and once on resume to avoid spamming the log every 30s.
 */
export async function waitWhilePaused(teamDir) {
	let loggedPause = false;
	while (await checkPause(teamDir)) {
		if (await checkStop(teamDir)) return 'stop';
		if (!loggedPause) {
			console.log('[runner] Paused (team/.pause detected) — holding until removed.');
			loggedPause = true;
		}
		await new Promise(r => setTimeout(r, PAUSE_POLL_MS));
	}
	if (loggedPause) console.log('[runner] Resumed (team/.pause cleared).');
	return 'ok';
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatTimestamp() {
	const now = new Date();
	const day = DAY_NAMES[now.getDay()];
	const month = MONTH_NAMES[now.getMonth()];
	const date = now.getDate();
	const year = now.getFullYear();
	const offset = -now.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	const offH = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
	const offM = String(Math.abs(offset) % 60).padStart(2, '0');
	const h = String(now.getHours()).padStart(2, '0');
	const m = String(now.getMinutes()).padStart(2, '0');
	const isoLocal = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}T${h}:${m}:${String(now.getSeconds()).padStart(2, '0')}${sign}${offH}:${offM}`;
	return `${day}, ${month} ${date}, ${year} ${h}:${m} local (${isoLocal})`;
}

export function slugify(text) {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export async function ensureLogsDir(teamDir) {
	const logsDir = join(teamDir, '.logs');
	await mkdir(logsDir, { recursive: true });
	return logsDir;
}

export function buildLogPath(logsDir, label, priority) {
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	return join(logsDir, `${label}.${priority}.${ts}.log`);
}

/**
 * Build the "Agent Tools" prompt section describing available MCP tools.
 * @param {'cycle'|'clerk'|'efficiency'} role
 *   - cycle: all tools, with "your open todos are already shown above" context
 *   - clerk: all tools, without the per-member context hints
 *   - efficiency: messaging tools only (clerk efficiency analysis just sends feedback)
 * @returns {string[]} prompt lines to spread into a parts array
 */
export function buildToolsPromptSection(role) {
	const lines = [
		'',
		'## Agent Tools',
		'',
		'You have the following MCP tools available.',
		'',
		'**Messaging** — see `teamos/docs/messages.md` for the full protocol:',
		'- **send_message** — Send a message (`to`, `body`, optional `subject`, `cc`, `replyTo`, `projectCode`). Returns `{ id, sentAt }`. Before composing to a recipient set you have already messaged this cycle, call `list_sent({ to: [...] })` — prefer `supersede_message` over stacking another message on the same topic.',
		'- **supersede_message** — Send a new message that consolidates / replaces one or more earlier messages YOU sent (`supersedes`, `to`, `body`, optional `subject`, `cc`, `replyTo`, `projectCode`). Predecessors are silently removed from recipients\' inboxes when still unread; the new `to`+`cc` must cover every recipient any predecessor reached.',
		'- **read_message** — Read any message by id (parent inlined one hop). `supersedes` and `supersededBy` fields surface consolidation links.',
		'- **list_inbox** / **list_sent** / **list_archives** — Browse your mailboxes. `list_sent` accepts an optional `to: [<member>, ...]` filter.',
		'- **archive_message** — Move a message from your inbox to your archives after handling it.',
		'- **unarchive_message** — Put an archived message back in your inbox.',
	];

	if (role === 'cycle') {
		lines.push('', 'Archive each inbox message you have fully handled. Messages left in your inbox carry forward to your next cycle.');
	}

	if (role === 'efficiency') return lines;

	const todoContext = role === 'cycle'
		? '. Your open todos are already shown above; call `list_todos` for a fresh view after several mutations'
		: '';
	const scheduleContext = role === 'cycle'
		? '. Your due and upcoming events are already shown above; call `list_events` for a fresh view after mutations'
		: '';

	lines.push(
		'',
		`**Tasks** — see \`teamos/docs/tasks.md\`${todoContext}:`,
		'- **list_todos** — Fetch every open todo on your list (priority order).',
		'- **add_todo** — Create a new todo (`title`, `priority`, optional `description`, `notes`, `projectCode`, `status`). Returns `{ id }`.',
		'- **update_todo** — Partial update of a todo by id (`title`, `description`, `priority`, `notes`, `projectCode`, `status`). Pass `status: "blocked"` to block, `status: null` to unblock.',
		'- **complete_todo** — Remove a todo from your list by id. There is no "done" state — completed work simply disappears.',
		'',
		'Treat todo ids as opaque strings. Never edit `team/members/<you>/todo.json` directly.',
		'',
		`**Schedule** — see \`teamos/docs/schedule.md\`${scheduleContext}:`,
		'- **list_events** — Fetch every event on your schedule (sorted by time, each tagged with `isDue`).',
		'- **add_event** — Create a new event (`title`, `time`, optional `description`, `recurrence`, `projectCode`). For recurring events, `time` is the first occurrence. Returns `{ id }`.',
		'- **update_event** — Partial update of an event by id. Pass `recurrence: null` to convert a recurring event into a one-time event at its current time.',
		'- **remove_event** — Delete an event entirely (cancels all future occurrences of a recurring event).',
		'',
		'**Do not advance recurrence yourself.** When a recurring event fires, the runner automatically advances its `time` to the next occurrence after this cycle completes. Do not call `update_event` just to bump the `time`. One-time events that fire are removed automatically — no `complete_event` needed. Treat event ids as opaque strings and never edit `team/members/<you>/schedule.json` directly.',
		'',
		`**Commit Triggers** — see \`teamos/docs/triggers.md\`. Subscribe yourself to host-repo commits matching filters (path globs, author, message regex) so reviews wake you at the priority you pick. Matching commits appear in the cycle prompt under "Commit Triggers Fired".`,
		'- **list_triggers** — Fetch every commit-trigger subscription you have.',
		'- **add_trigger** — Subscribe to commits (`priority`, optional `paths`, `author`, `authorNot`, `messageMatches`, `reason`). Returns `{ id }`.',
		'- **update_trigger** — Partial update of a trigger by id.',
		'- **remove_trigger** — Unsubscribe by removing a trigger.',
		'',
		'Commits authored by you are skipped by default. The runner advances your cursor after a successful cycle — you never see the same commit twice.',
	);

	return lines;
}
