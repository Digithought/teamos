import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgent } from '../agents/index.mjs';
import { buildChatPrompt, buildTranscriptMessage } from './prompt.mjs';

/** A chat left open this long with no turn is ended (and filed) on the next request. */
const IDLE_SESSION_MS = 30 * 60 * 1000;

/** A cycle prompt file older than this is assumed orphaned by a killed runner, not in flight. */
const STALE_CYCLE_MS = 60 * 60 * 1000;

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

/**
 * Live chat sessions, held in the dashboard process.
 *
 * A session is a transcript plus at most one running agent. Every turn spawns
 * a fresh agent through the same `runAgent` the cycle path uses — members are
 * stateless between cycles, so an instance handed the manifest and state *is*
 * the member, and the transcript carried in the prompt is the session's only
 * memory. Nothing is written until the chat ends, and then only one message.
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
		/** @type {Map<string, Object>} */
		this.sessions = new Map();
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
		};
	}

	/**
	 * Start a session. One open chat per member: a second one would mean two
	 * transcripts of the same member diverging in parallel and two agents
	 * billing the account, and there is no merge story for either. The human
	 * ends the first chat or joins nothing.
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
			lastActiveAt: new Date().toISOString(),
			transcript: [],
			busy: false,
			abort: null,
			logFile: null,
		};
		this.sessions.set(session.id, session);
		return session;
	}

	/**
	 * Run one turn. `onEvent` receives the agent's stream events as they
	 * arrive; `signal` aborts the turn (the client hung up), which tree-kills
	 * the child rather than leaving it to bill out the idle timeout.
	 *
	 * The human's turn is recorded even when the agent fails, so a crashed turn
	 * still shows up in the filed transcript instead of silently vanishing.
	 */
	async turn(id, text, { onEvent, signal } = {}) {
		const session = this.get(id);
		if (session.busy) throw chatError(409, 'This chat is still working on the previous turn.');
		const said = (text ?? '').trim();
		if (!said) throw chatError(400, 'Nothing to send.');

		const prompt = await buildChatPrompt(
			{ name: session.member, title: session.title },
			this.teamDir,
			this.adapters,
			{ human: session.human, transcript: session.transcript },
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
		let exitCode = 1;
		try {
			exitCode = await runAgent(this.chatConfig.agent, prompt, this.repoRoot, session.logFile, undefined, {
				// No MCP context and no MCP config: a chat session has no teamos
				// tools, which is how "write-narrow" is enforced rather than merely
				// requested. readOnly denies the workspace-writing built-ins too.
				agentOptions: {
					mcp: false,
					readOnly: true,
					task: `${session.human} says:\n\n${said}`,
				},
				env: this.chatConfig.env,
				onEvent: collect,
				signal: controller.signal,
				quiet: true,
			});
		} finally {
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
	 * member, so the next cycle reads it in the inbox like any other mail. This
	 * append is the session's only write, and an empty chat writes nothing.
	 */
	async end(id, { persist = true } = {}) {
		const session = this.get(id);
		this.sessions.delete(id);
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

	async status(member) {
		await this.sweepIdle();
		const session = this.find(member);
		return {
			...(await detectMidCycle(this.teamDir, member)),
			session: session ? this.summarize(session) : null,
		};
	}
}
