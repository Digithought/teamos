import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgent } from '../agents/index.mjs';
import { buildChatPrompt, buildTranscriptMessage } from './prompt.mjs';

/** A chat left open this long with no turn is ended (and filed) on the next request. */
const IDLE_SESSION_MS = 30 * 60 * 1000;

/** A cycle prompt file older than this is assumed orphaned by a killed runner, not in flight. */
const STALE_CYCLE_MS = 60 * 60 * 1000;

/** How often an open chat looks for a cycle of its member finishing. */
const CYCLE_POLL_MS = 5 * 1000;

/** How much of a cycle log's tail is read looking for the runner's exit marker. */
const LOG_TAIL_BYTES = 4096;

/** `runAgent` ends every log with this line — the one reliable "the cycle is over" marker. */
const EXIT_MARKER = /\[runner\] Agent exited with code (-?\d+)/g;

/** Error with an HTTP status the dashboard can hand straight back to the client. */
function chatError(status, message) {
	const err = new Error(message);
	err.status = status;
	return err;
}

function makeSessionId() {
	const iso = new Date().toISOString().replace(/:/g, '-');
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
	return `${iso}-${rand}`;
}

/**
 * Resolve the `chat` section of teamos.config.json.
 *
 * Credentials are not a teamos concept — the Claude CLI reads its own env vars
 * (`CLAUDE_CODE_OAUTH_TOKEN`, falling back to `ANTHROPIC_API_KEY`) and the
 * runner simply inherits them. Chat follows the same rule, with one addition:
 * `chat.env` layers vars over the inherited ones for chat spawns only, so
 * conversation tokens can be billed to a different account than the cycles
 * running in the same process's environment. Values are `$VAR` references
 * resolved by `resolveEnvVars` before this sees them; anything still starting
 * with `$` means the variable is unset, and is dropped rather than exported
 * literally — an env var holding the string "$FOO" would fail authentication
 * in a way that reads like a CLI bug.
 */
export function resolveChatConfig(config = {}) {
	const chat = config.chat ?? {};
	const env = {};
	for (const [key, value] of Object.entries(chat.env ?? {})) {
		if (typeof value !== 'string' || value.startsWith('$')) {
			console.warn(`[chat] chat.env.${key} is unresolved — falling back to the inherited environment.`);
			continue;
		}
		env[key] = value;
	}
	return { agent: chat.agent || config.agent || 'claude', env };
}

/**
 * Is a scheduled cycle for this member running right now?
 *
 * There is no runner-side registry to ask, and chat deliberately starts no
 * coordination protocol with the runner (see teamos/docs/chat.md). What does
 * exist is a side effect: `runAgent` writes `<member>.<priority>.<ts>.prompt.md`
 * next to the cycle log before spawning and unlinks it in a `finally`. Its
 * presence is therefore "an agent is running for this member", and a file left
 * behind by a killed runner ages out. This is an indicator for the human, not
 * a lock — nothing branches on it.
 */
export async function detectMidCycle(teamDir, member) {
	const logsDir = join(teamDir, '.logs');
	const prefix = `${member}.`;
	let entries;
	try {
		entries = await readdir(logsDir);
	} catch {
		return { midCycle: false };
	}
	let newest = null;
	for (const entry of entries) {
		if (!entry.startsWith(prefix) || !entry.endsWith('.prompt.md')) continue;
		const mtimeMs = await stat(join(logsDir, entry))
			.then((s) => s.mtimeMs)
			.catch(() => null);
		if (mtimeMs === null || Date.now() - mtimeMs > STALE_CYCLE_MS) continue;
		if (!newest || mtimeMs > newest) newest = mtimeMs;
	}
	return newest ? { midCycle: true, since: new Date(newest).toISOString() } : { midCycle: false };
}

/** The cycle prompt files currently sitting next to the logs for this member. */
async function liveCyclePrompts(teamDir, member) {
	const logsDir = join(teamDir, '.logs');
	const prefix = `${member}.`;
	const entries = await readdir(logsDir).catch(() => []);
	return entries.filter((e) => e.startsWith(prefix) && e.endsWith('.prompt.md'));
}

/**
 * Read the exit code the runner recorded at the end of a cycle log.
 *
 * `runAgent` closes every log with `[runner] Agent exited with code <n>`,
 * written in the same `settle()` that resolves the run — so the marker's
 * presence means the cycle is genuinely over, not merely that its prompt file
 * vanished. Only the tail is read: a cycle log can be megabytes.
 */
export async function readCycleExit(logFile) {
	let handle;
	try {
		handle = await open(logFile, 'r');
		const { size } = await handle.stat();
		const start = Math.max(0, size - LOG_TAIL_BYTES);
		const buf = Buffer.alloc(Math.min(size, LOG_TAIL_BYTES));
		await handle.read(buf, 0, buf.length, start);
		const tail = buf.toString('utf-8');
		let match;
		let last = null;
		EXIT_MARKER.lastIndex = 0;
		while ((match = EXIT_MARKER.exec(tail)) !== null) last = match[1];
		return last === null ? null : Number(last);
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * Which of the member's own files were written since `sinceMs`.
 *
 * Mtimes, not content hashes or a change journal: the question a chat needs
 * answered is "is what I said ten minutes ago still true?", and a file the
 * other instance rewrote to the same bytes is not a case worth the extra cost.
 * Coarse in the other direction too — a cycle that touches `state.md` marks it
 * changed whether or not the change matters to this conversation. That is the
 * right way to be wrong here: the remedy is a re-read, which is cheap.
 *
 * Only the member's directory is walked. The team-wide files (org, memos,
 * projects, roster) are reassembled into every turn's prompt anyway, so the
 * instance already sees them fresh.
 */
export async function changedFilesSince(teamDir, member, sinceMs) {
	const memberDir = join(teamDir, 'members', member);
	const entries = await readdir(memberDir, { withFileTypes: true }).catch(() => []);
	const changed = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const mtimeMs = await stat(join(memberDir, entry.name))
			.then((s) => s.mtimeMs)
			.catch(() => null);
		if (mtimeMs !== null && mtimeMs > sinceMs) changed.push(`team/members/${member}/${entry.name}`);
	}
	return changed.sort();
}

/**
 * Live chat sessions, held in the dashboard process.
 *
 * A session is a transcript plus at most one running agent. Every turn spawns
 * a fresh agent through the same `runAgent` the cycle path uses, with the same
 * tools — members are stateless between cycles, so an instance handed the
 * manifest and state *is* the member, and the transcript carried in the prompt
 * is the session's only memory.
 *
 * A chat and a scheduled cycle for the same member may run at the same time.
 * Neither waits for the other: the guard against two instances clobbering each
 * other is the file tools' own optimistic concurrency, plus telling the chat
 * instance plainly that it is the second one (`agent-rules/chat.md`). What
 * this class adds is awareness — it watches for a cycle finishing and tells
 * both the human and the next turn which files moved underneath them.
 */
export class ChatSessions {
	/**
	 * @param {Object} opts
	 * @param {string} opts.teamDir
	 * @param {string} opts.repoRoot - cwd for spawned agents (the host project root)
	 * @param {Object} opts.adapters - { messaging, tasks, schedule }
	 * @param {Object} [opts.config] - parsed teamos.config.json
	 */
	constructor({ teamDir, repoRoot, adapters, config }) {
		this.teamDir = teamDir;
		this.repoRoot = repoRoot;
		this.adapters = adapters ?? {};
		this.chatConfig = resolveChatConfig(config);
		// A chat spawn now carries the same MCP servers a cycle does, so it needs
		// the same context: `.mcp.json` interpolates these into the teamos-tools
		// server's env, and an unset TEAMOS_MEMBER_NAME would point the member's
		// own tools at nobody.
		this.mcpContext = {
			teamDir,
			memberName: null,
			messagingAdapterName: config?.messaging?.adapter || 'file',
			tasksAdapterName: config?.tasks?.adapter || 'file',
			scheduleAdapterName: config?.schedule?.adapter || 'file',
			triggersAdapterName: config?.triggers?.adapter || 'file',
			watchesAdapterName: config?.watches?.adapter || 'file',
		};
		/** @type {Map<string, Object>} */
		this.sessions = new Map();
		this.cycleTimer = null;
	}

	/**
	 * Start/stop the cycle watcher with the first/last open session. The timer
	 * is unref'd so it never holds the process open — this runs inside the
	 * dashboard, and a poll is not a reason to stay alive.
	 */
	_syncWatcher() {
		if (this.sessions.size > 0 && !this.cycleTimer) {
			this.cycleTimer = setInterval(() => {
				this.pollCycles().catch((err) => console.error(`[chat] cycle watch failed: ${err.message}`));
			}, CYCLE_POLL_MS);
			this.cycleTimer.unref?.();
		} else if (this.sessions.size === 0 && this.cycleTimer) {
			clearInterval(this.cycleTimer);
			this.cycleTimer = null;
		}
	}

	/** Subscribe to a session's out-of-band events (a cycle finishing). */
	_emit(session, event) {
		for (const listener of session.listeners) {
			try {
				listener(event);
			} catch {
				/* a dead SSE stream must not break the watcher */
			}
		}
	}

	/**
	 * Look for cycles of each open chat's member finishing.
	 *
	 * The runner keeps no registry to subscribe to, so this watches the same
	 * side effect `detectMidCycle` reads: a cycle's `<member>.<priority>.<ts>.prompt.md`
	 * is written before the spawn and unlinked in a `finally`. A prompt file
	 * this session had seen and that is now gone means that cycle ended; the
	 * sibling `.log` is then checked for `runAgent`'s exit marker, so a file
	 * removed by hand or by a log sweep does not masquerade as a completion.
	 *
	 * A cycle that starts and finishes entirely between two polls is missed.
	 * That is acceptable: the changed-file list handed to the next turn is
	 * computed from mtimes against the chat's start, not from these events, so
	 * the instance still finds out — it just doesn't get a banner.
	 */
	async pollCycles() {
		for (const session of [...this.sessions.values()]) {
			await this._pollSessionCycles(session).catch(() => {});
		}
	}

	async _pollSessionCycles(session) {
		const live = new Set(await liveCyclePrompts(this.teamDir, session.member));
		const found = [];
		for (const name of [...session.cyclePrompts]) {
			if (live.has(name)) continue;
			session.cyclePrompts.delete(name);
			const logFile = join(this.teamDir, '.logs', name.replace(/\.prompt\.md$/, '.log'));
			const exitCode = await readCycleExit(logFile);
			if (exitCode === null) continue; // gone, but never finished — not a completion
			const completion = { at: new Date().toISOString(), exitCode };
			session.cycleCompletions.push(completion);
			found.push(completion);
			this._emit(session, { kind: 'cycle', event: 'completed', exitCode, at: completion.at });
		}
		for (const name of live) session.cyclePrompts.add(name);
		return found;
	}

	async _lookupMember(name) {
		const raw = await readFile(join(this.teamDir, 'members.json'), 'utf-8').catch(() => null);
		if (!raw) throw chatError(500, 'team/members.json is unreadable — cannot start a chat.');
		let members = [];
		try {
			members = JSON.parse(raw).members ?? [];
		} catch {
			throw chatError(500, 'team/members.json is not valid JSON — cannot start a chat.');
		}
		const match = members.find((m) => m?.name === name);
		if (!match) throw chatError(404, `Member "${name}" is not in members.json.`);
		return match;
	}

	find(member) {
		for (const session of this.sessions.values()) {
			if (session.member === member) return session;
		}
		return null;
	}

	get(id) {
		const session = this.sessions.get(id);
		if (!session) throw chatError(404, 'Chat session not found — it may have been ended or timed out.');
		return session;
	}

	summarize(session) {
		return {
			id: session.id,
			member: session.member,
			human: session.human,
			startedAt: session.startedAt,
			lastActiveAt: session.lastActiveAt,
			busy: session.busy,
			transcript: session.transcript,
			cycleCompletions: session.cycleCompletions,
		};
	}

	/**
	 * Start a session. One open chat per member: a second one would mean two
	 * transcripts of the same member diverging in parallel and two agents
	 * billing the account, and there is no merge story for either. The human
	 * ends the first chat or joins nothing.
	 *
	 * A cycle already in flight is no reason to refuse — the chat opens beside
	 * it. The prompt files live at that moment are recorded so the watcher can
	 * tell the human when the cycle it was already running finishes.
	 */
	async create({ member, human }) {
		await this.sweepIdle();
		if (!human) throw chatError(400, 'A chat needs a human identity — pick who you are in the dashboard first.');
		const entry = await this._lookupMember(member);
		const existing = this.find(member);
		if (existing) {
			throw chatError(409, `A chat with ${member} is already open (started ${existing.startedAt}). End it first.`);
		}
		const session = {
			id: makeSessionId(),
			member,
			title: entry.title ?? '',
			human,
			startedAt: new Date().toISOString(),
			startedAtMs: Date.now(),
			lastActiveAt: new Date().toISOString(),
			transcript: [],
			busy: false,
			abort: null,
			logFile: null,
			/** Cycle prompt files seen live; one disappearing is a cycle ending. */
			cyclePrompts: new Set(await liveCyclePrompts(this.teamDir, member)),
			cycleCompletions: [],
			/** Attached SSE writers — the running turn, when there is one. */
			listeners: new Set(),
		};
		this.sessions.set(session.id, session);
		this._syncWatcher();
		return session;
	}

	/**
	 * Run one turn. `onEvent` receives the agent's stream events as they
	 * arrive; `signal` aborts the turn (the client hung up), which tree-kills
	 * the child rather than leaving it to bill out the idle timeout.
	 *
	 * The human's turn is recorded even when the agent fails, so a crashed turn
	 * still shows up in the filed transcript instead of silently vanishing.
	 *
	 * Each turn is handed the member files written since the chat opened. The
	 * sections above them in the prompt are rebuilt every turn and are already
	 * current; what goes stale is the conversation, so the list exists to tell
	 * the instance which of its own earlier answers to distrust.
	 */
	async turn(id, text, { onEvent, signal } = {}) {
		const session = this.get(id);
		if (session.busy) throw chatError(409, 'This chat is still working on the previous turn.');
		const said = (text ?? '').trim();
		if (!said) throw chatError(400, 'Nothing to send.');

		// Catch a cycle that ended since the last poll before the prompt is
		// built, so the turn about to run sees it rather than the one after.
		await this._pollSessionCycles(session).catch(() => {});
		const changedFiles = await changedFilesSince(this.teamDir, session.member, session.startedAtMs);

		const prompt = await buildChatPrompt(
			{ name: session.member, title: session.title },
			this.teamDir,
			this.adapters,
			{ human: session.human, transcript: session.transcript, changedFiles },
		);
		session.transcript.push({ role: 'human', text: said, at: new Date().toISOString() });
		session.lastActiveAt = new Date().toISOString();

		if (!session.logFile) {
			const chatLogs = join(this.teamDir, '.logs', 'chat');
			await mkdir(chatLogs, { recursive: true });
			session.logFile = join(chatLogs, `${session.member}.${session.id}.log`);
		}

		const reply = [];
		let result = '';
		const collect = (event) => {
			if (event.kind === 'text' && event.content) reply.push(event.content);
			if (event.kind === 'result' && event.content) result = event.content;
			onEvent?.(event);
		};

		// One turn at a time. The controller is kept on the session so ending the
		// chat (or a sweep) kills a turn still in flight instead of orphaning it.
		const controller = new AbortController();
		signal?.addEventListener('abort', () => controller.abort(), { once: true });
		if (signal?.aborted) controller.abort();
		session.busy = true;
		session.abort = () => controller.abort();
		// While the turn is streaming it is also the chat's live channel to the
		// browser, so the cycle watcher's events ride out on it.
		session.listeners.add(collect);
		let exitCode = 1;
		try {
			exitCode = await runAgent(
				this.chatConfig.agent,
				prompt,
				this.repoRoot,
				session.logFile,
				{ ...this.mcpContext, memberName: session.member },
				{
					// Same tools a cycle gets. A chat instance is the member, and a
					// member that cannot act has to file everything for its next self
					// — see teamos/docs/chat.md.
					agentOptions: { task: `${session.human} says:\n\n${said}` },
					env: this.chatConfig.env,
					onEvent: collect,
					signal: controller.signal,
					quiet: true,
				},
			);
		} finally {
			session.listeners.delete(collect);
			session.busy = false;
			session.abort = null;
			session.lastActiveAt = new Date().toISOString();
		}

		// The final `result` event repeats the last assistant text, so it is only
		// used when nothing streamed (an agent that answered in one shot).
		const answer = reply.join('').trim() || result.trim();
		if (answer) {
			session.transcript.push({ role: 'member', text: answer, at: new Date().toISOString() });
		}
		return { exitCode, answer };
	}

	/**
	 * End a session and file the transcript as a message from the human to the
	 * member, so it lands in the record like any other mail. The chat instance
	 * may already have acted on everything said here — the transcript is the
	 * account of the conversation, not the queue of what to do about it.
	 * An empty chat writes nothing.
	 */
	async end(id, { persist = true } = {}) {
		const session = this.get(id);
		this.sessions.delete(id);
		this._syncWatcher();
		if (session.abort) session.abort();
		if (!persist || session.transcript.length === 0 || !this.adapters.messaging) {
			return { persisted: false };
		}
		const message = buildTranscriptMessage({
			member: session.member,
			human: session.human,
			transcript: session.transcript,
			startedAt: session.startedAt,
			endedAt: new Date().toISOString(),
		});
		const { id: messageId } = await this.adapters.messaging.sendMessage(message);
		return { persisted: true, messageId };
	}

	/** File and drop sessions the human walked away from. Runs on session create/status. */
	async sweepIdle() {
		const cutoff = Date.now() - IDLE_SESSION_MS;
		for (const session of [...this.sessions.values()]) {
			if (session.busy) continue;
			if (Date.parse(session.lastActiveAt) > cutoff) continue;
			await this.end(session.id).catch((err) => {
				console.error(`[chat] failed to file idle session ${session.id}: ${err.message}`);
			});
		}
	}

	/**
	 * The pane polls this. `midCycle` is informational — chat neither waits for
	 * a cycle nor holds one up. `changedFiles` and the session's
	 * `cycleCompletions` are what tell the human the ground moved while they
	 * were typing; the same list goes into the next turn's prompt.
	 */
	async status(member) {
		await this.sweepIdle();
		const session = this.find(member);
		if (session) await this._pollSessionCycles(session).catch(() => {});
		return {
			...(await detectMidCycle(this.teamDir, member)),
			session: session ? this.summarize(session) : null,
			changedFiles: session ? await changedFilesSince(this.teamDir, member, session.startedAtMs) : [],
		};
	}
}
