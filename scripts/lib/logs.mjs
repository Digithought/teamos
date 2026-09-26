/**
 * Read-only access to a member's agent logs for the dashboard's Logs tab.
 *
 * Every agent run writes a plain-text log into `team/.logs/` (see
 * `runAgent` in agents/index.mjs and `formatClaudeJsonLine` in agents/claude.mjs):
 *
 *   <Member>.<priority>.<ISO ts, ':' and '.' → '-'>.log   a cycle (buildLogPath)
 *   chat/<Member>.<sessionId>.log                          a dashboard chat, all turns
 *
 * `clerk.*` logs belong to no member and are not listed. Nor are the
 * `.prompt.md` siblings, which exist only while an agent runs — they are read
 * here as the "still running" marker, the same side effect chat's
 * detectMidCycle reads.
 *
 * The dashboard is reachable over the tailnet and its process runs agents with
 * full permissions, so every name that reaches the filesystem is checked twice:
 * against a strict single-segment pattern, then by resolving the path and
 * confirming it is still inside `.logs/` and is a regular file, not a link.
 */

import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/** Same rule the dashboard applies when creating a member. */
const MEMBER_RE = /^[A-Za-z][A-Za-z0-9_-]{0,48}$/;
/** `<priority>.<YYYY-MM-DDTHH-MM-SS-mmmZ>.log` after the member prefix. */
const CYCLE_RE = /^([A-Za-z]{1,32})\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.log$/;
/** A chat session id: `makeSessionId` today, kept loose enough to survive a format tweak. */
const CHAT_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,80})\.log$/;

/** `runAgent` closes every run with this; a resumed run appends a second one. */
const EXIT_MARKER = /^\[runner\] Agent exited with code (-?\d+)\s*$/gm;
/** `formatClaudeJsonLine`'s result line: `[RESULT DONE | 123.4s | cost $1.2345]`. */
const RESULT_LINE = /^\[RESULT (DONE|ERROR)((?: \| [^\]|]+)*)\]\s*$/gm;

/**
 * A run whose log has not grown in this long is not running, whatever its
 * prompt file says: `runAgent` kills an agent after 10 minutes without output,
 * so a prompt file older than that was left by a runner that was itself killed.
 */
export const STALE_RUN_MS = 15 * 60 * 1000;

/** Default and ceiling for one read. Logs run to megabytes; the UI pages through them. */
export const DEFAULT_TAIL_BYTES = 64 * 1024;
export const MAX_READ_BYTES = 1024 * 1024;

/** Logs bigger than this are summarized from their tail only. */
const FULL_SCAN_LIMIT = 4 * 1024 * 1024;

function logsError(status, message) {
	const err = new Error(message);
	err.status = status;
	return err;
}

export function isValidMember(member) {
	return typeof member === 'string' && MEMBER_RE.test(member);
}

/** `2026-09-25T16-02-56-134Z` or `2026-09-25T16-02-56.134Z` → ISO, or null. */
function stampToIso(stamp) {
	const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})[-.](\d{3})Z/.exec(stamp);
	if (!m) return null;
	const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
	return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Classify a file name as one of `member`'s logs, or null. `kind` says which
 * directory it lives in, so a chat name is never looked up among cycles.
 * @returns {{ kind: 'cycle'|'chat', priority: string|null, startedAt: string|null } | null}
 */
export function parseLogName(member, name, kind = 'cycle') {
	if (!isValidMember(member) || typeof name !== 'string') return null;
	const prefix = `${member}.`;
	if (!name.startsWith(prefix)) return null;
	const rest = name.slice(prefix.length);
	if (rest.includes('..')) return null;
	if (kind === 'cycle') {
		const m = CYCLE_RE.exec(rest);
		return m ? { kind, priority: m[1], startedAt: stampToIso(m[2]) } : null;
	}
	if (kind === 'chat') {
		const m = CHAT_RE.exec(rest);
		return m ? { kind, priority: null, startedAt: stampToIso(m[1]) } : null;
	}
	return null;
}

/**
 * Pull the exit code, agent time and cost out of a log's text. Every `[RESULT]`
 * line counts — a chat has one per turn, and a cycle resumed to clean up its
 * leftovers has two — and the last exit marker wins.
 */
export function summarizeLog(text) {
	let exitCode = null;
	let exits = 0;
	for (const m of text.matchAll(EXIT_MARKER)) {
		exitCode = Number(m[1]);
		exits++;
	}
	let results = 0;
	let errors = 0;
	let durationSec = null;
	let costUsd = null;
	for (const m of text.matchAll(RESULT_LINE)) {
		results++;
		if (m[1] === 'ERROR') errors++;
		for (const part of m[2].split('|')) {
			const field = part.trim();
			const dur = /^(\d+(?:\.\d+)?)s$/.exec(field);
			if (dur) durationSec = (durationSec ?? 0) + Number(dur[1]);
			const cost = /^cost \$(\d+(?:\.\d+)?)$/.exec(field);
			if (cost) costUsd = (costUsd ?? 0) + Number(cost[1]);
		}
	}
	const started = /^Started: (\S+)$/m.exec(text.slice(0, 2048));
	return {
		exitCode,
		runs: exits,
		results,
		resultErrors: errors,
		durationSec: durationSec === null ? null : Math.round(durationSec * 10) / 10,
		costUsd: costUsd === null ? null : Math.round(costUsd * 10000) / 10000,
		headerStartedAt: started && !Number.isNaN(Date.parse(started[1])) ? started[1] : null,
	};
}

/** `running` while the prompt file is fresh; otherwise by the last exit code. */
export function logStatus({ running, exitCode }) {
	if (running) return 'running';
	if (exitCode === null) return 'interrupted';
	return exitCode === 0 ? 'ok' : 'failed';
}

async function readBytes(path, from, to) {
	const handle = await open(path, 'r');
	try {
		const buf = Buffer.alloc(Math.max(0, to - from));
		const { bytesRead } = await handle.read(buf, 0, buf.length, from);
		return buf.subarray(0, bytesRead);
	} finally {
		await handle.close().catch(() => {});
	}
}

/** Length of an incomplete UTF-8 sequence at the end of `buf` (0 if it ends cleanly). */
function danglingUtf8(buf) {
	for (let back = 1; back <= Math.min(3, buf.length); back++) {
		const byte = buf[buf.length - back];
		if ((byte & 0xc0) === 0x80) continue; // continuation byte — keep looking for the lead
		const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return need > back ? back : 0;
	}
	return 0;
}

/**
 * The logs directory for one member's logs of `kind`, and a path inside it,
 * or a 400/404. Nothing outside `.logs/` can come back from here.
 */
export async function resolveLogFile(teamDir, member, name) {
	if (!isValidMember(member)) throw logsError(400, 'Invalid member name');
	const logsDir = resolve(teamDir, '.logs');
	let kind = null;
	for (const k of ['cycle', 'chat']) {
		if (parseLogName(member, name, k)) {
			kind = k;
			break;
		}
	}
	if (!kind) throw logsError(400, 'Invalid log name');
	const dir = kind === 'chat' ? join(logsDir, 'chat') : logsDir;
	const path = resolve(dir, name);
	if (!path.startsWith(dir + sep) || path.slice(dir.length + 1) !== name) {
		throw logsError(400, 'Invalid log name');
	}
	let info;
	try {
		info = await lstat(path);
	} catch {
		// A cycle-shaped name may also be a chat id; try the other directory once.
		if (kind === 'cycle' && parseLogName(member, name, 'chat')) {
			const chatPath = resolve(logsDir, 'chat', name);
			if (chatPath.startsWith(join(logsDir, 'chat') + sep)) {
				try {
					const chatInfo = await lstat(chatPath);
					if (chatInfo.isFile()) return { path: chatPath, kind: 'chat', info: chatInfo };
				} catch {
					/* fall through */
				}
			}
		}
		throw logsError(404, 'Log not found');
	}
	if (!info.isFile()) throw logsError(404, 'Log not found');
	return { path, kind, info };
}

/**
 * The dashboard's log reader. Summaries are cached per file by (mtime, size),
 * so listing a member with a hundred finished cycles reads each one once.
 */
export function createLogReader(teamDir, { now = () => Date.now() } = {}) {
	const logsDir = resolve(teamDir, '.logs');
	const cache = new Map();

	async function summaryFor(path, info) {
		const hit = cache.get(path);
		if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.summary;
		const from = info.size > FULL_SCAN_LIMIT ? info.size - DEFAULT_TAIL_BYTES : 0;
		let text = (await readBytes(path, from, info.size)).toString('utf-8');
		// The header sits at the top; a tail-only scan still wants it.
		if (from > 0) text = `${(await readBytes(path, 0, 2048)).toString('utf-8')}\n${text}`;
		const summary = summarizeLog(text);
		cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, summary });
		return summary;
	}

	async function describe(dir, name, parsed, names) {
		const path = join(dir, name);
		let info;
		try {
			info = await lstat(path);
		} catch {
			return null;
		}
		if (!info.isFile()) return null;
		const summary = await summaryFor(path, info);
		const promptName = name.replace(/\.log$/, '.prompt.md');
		const running = names.has(promptName) && now() - info.mtimeMs < STALE_RUN_MS;
		const startedAt = parsed.startedAt ?? summary.headerStartedAt ?? new Date(info.birthtimeMs || info.mtimeMs).toISOString();
		const updatedAt = new Date(info.mtimeMs).toISOString();
		const wallSec = Math.max(0, Math.round(((running ? now() : info.mtimeMs) - Date.parse(startedAt)) / 1000));
		return {
			name,
			kind: parsed.kind,
			priority: parsed.priority,
			startedAt,
			updatedAt,
			size: info.size,
			running,
			status: logStatus({ running, exitCode: summary.exitCode }),
			exitCode: summary.exitCode,
			// A chat sits idle between turns, so its wall clock says little; its agent time is the sum.
			durationSec: summary.durationSec !== null && (parsed.kind === 'chat' || !running) ? summary.durationSec : wallSec,
			costUsd: summary.costUsd,
			runs: summary.runs,
		};
	}

	async function listDir(dir, member, kind) {
		const entries = await readdir(dir).catch(() => []);
		const names = new Set(entries);
		const out = [];
		for (const name of entries) {
			const parsed = parseLogName(member, name, kind);
			if (!parsed) continue;
			const entry = await describe(dir, name, parsed, names);
			if (entry) out.push(entry);
		}
		return out;
	}

	return {
		/** Every log of `member`, cycles and chats together, newest first. */
		async list(member) {
			if (!isValidMember(member)) throw logsError(400, 'Invalid member name');
			const all = [...(await listDir(logsDir, member, 'cycle')), ...(await listDir(join(logsDir, 'chat'), member, 'chat'))];
			all.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.name.localeCompare(a.name));
			return all;
		},

		/**
		 * Read part of one log.
		 *
		 * - `{ tail: n }` (the default): the last n bytes.
		 * - `{ from, to }`: that byte range — how the UI loads earlier text.
		 * - `{ from }` alone: everything from `from` on — how the UI follows a running log.
		 *
		 * Reads are capped at MAX_READ_BYTES. A bounded read (tail, or from+to)
		 * that starts mid-line drops the partial first line so the text opens on
		 * a line boundary; an open-ended read never drops anything, because its
		 * `from` is the previous read's `to`. The returned `from`/`to` are the
		 * bytes actually covered — pass `to` back as the next `from`.
		 */
		async read(member, name, opts = {}) {
			const { path, kind, info } = await resolveLogFile(teamDir, member, name);
			const size = info.size;
			const clamp = (n) => Math.min(size, Math.max(0, Math.floor(Number(n))));
			let from;
			let to;
			let bounded = true;
			if (opts.from !== undefined && opts.from !== null && Number.isFinite(Number(opts.from))) {
				from = clamp(opts.from);
				if (opts.to !== undefined && opts.to !== null && Number.isFinite(Number(opts.to))) {
					to = Math.max(from, clamp(opts.to));
					from = Math.max(from, to - MAX_READ_BYTES);
				} else {
					to = Math.min(size, from + MAX_READ_BYTES);
					bounded = false;
				}
			} else {
				const tail = Number.isFinite(Number(opts.tail)) && Number(opts.tail) > 0 ? Number(opts.tail) : DEFAULT_TAIL_BYTES;
				to = size;
				from = Math.max(0, size - Math.min(Math.floor(tail), MAX_READ_BYTES));
			}

			let buf = await readBytes(path, bounded && from > 0 ? from - 1 : from, to);
			if (bounded && from > 0) {
				// buf[0] is the byte before `from`: start on the line after it unless it ends one.
				const nl = buf.indexOf(0x0a);
				const skip = nl === -1 ? 1 : nl + 1;
				from = from - 1 + skip;
				buf = buf.subarray(skip);
			}
			// Never start inside a multi-byte character (a caller-chosen `from` might).
			let lead = 0;
			while (from > 0 && lead < buf.length && lead < 3 && (buf[lead] & 0xc0) === 0x80) lead++;
			from += lead;
			buf = buf.subarray(lead);
			const dangling = danglingUtf8(buf);
			if (dangling) buf = buf.subarray(0, buf.length - dangling);
			to = from + buf.length;

			const names = new Set(await readdir(kind === 'chat' ? join(logsDir, 'chat') : logsDir).catch(() => []));
			const running = names.has(name.replace(/\.log$/, '.prompt.md')) && now() - info.mtimeMs < STALE_RUN_MS;
			const tailSummary = summarizeLog((await readBytes(path, Math.max(0, size - 4096), size)).toString('utf-8'));
			return {
				name,
				kind,
				size,
				from,
				to,
				text: buf.toString('utf-8'),
				running,
				exitCode: tailSummary.exitCode,
				status: logStatus({ running, exitCode: tailSummary.exitCode }),
			};
		},
	};
}
