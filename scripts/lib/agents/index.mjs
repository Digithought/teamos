import { execSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { createAuggieAdapter } from './auggie.mjs';
import { createClaudeAdapter } from './claude.mjs';
import { createCursorAdapter } from './cursor.mjs';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes with no output → assume hung

/**
 * Force-kill a child process and all its descendants.
 *
 * On Windows we spawn agents with `shell: true`, which means `child` is
 * `cmd.exe` wrapping the actual agent (often a Node process behind a `.cmd`
 * shim). A plain `child.kill()` only terminates cmd.exe — the agent is
 * orphaned, keeps running, and may hold log/prompt files or pipes open.
 * `taskkill /T /F` walks the process tree and force-kills every descendant.
 * On POSIX, `child.kill('SIGKILL')` is sufficient because the runner does
 * not detach into its own process group.
 */
function killTree(child) {
	if (!child || child.killed || child.exitCode != null) return;
	if (process.platform === 'win32') {
		try {
			execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
		} catch {
			try {
				child.kill('SIGKILL');
			} catch {
				/* already gone */
			}
		}
	} else {
		try {
			child.kill('SIGKILL');
		} catch {
			/* already gone */
		}
	}
}

/** Agent adapter registry. */
const agents = {
	claude: createClaudeAdapter,
	cursor: createCursorAdapter,
	auggie: createAuggieAdapter,
};

/** Adapters that can continue a finished session (`options.resume` in runAgent). */
const RESUMABLE = new Set(['claude']);

/** Whether `agentName` can resume a session. */
export function agentSupportsResume(agentName) {
	return RESUMABLE.has(agentName);
}

/**
 * Git author for a member's commits, so history says which member made each one.  The
 * committer stays whoever runs the runner.  TEAMOS_GIT_AUTHOR_EMAIL may give a per-member
 * address with `{member}` (lowercased name) in it; otherwise the runner's own email is kept,
 * so hosts that match commits to accounts by email still credit the human who runs the team.
 */
export function gitAuthorEnv(memberName, env = process.env) {
	if (!memberName) return {};
	const out = { GIT_AUTHOR_NAME: `${memberName} (teamos)` };
	const template = env.TEAMOS_GIT_AUTHOR_EMAIL;
	if (template) out.GIT_AUTHOR_EMAIL = template.replaceAll('{member}', memberName.toLowerCase());
	return out;
}

/** Get list of available agent names. */
export function getAvailableAgents() {
	return Object.keys(agents);
}

/**
 * Build the env vars the MCP server reads, merged onto the runner's env so
 * `${TEAMOS_MEMBER_NAME}` interpolation in the project's static `.mcp.json`
 * (installed by `init.mjs`) resolves to the active member for this cycle.
 */
function buildMcpEnv(mcpContext) {
	if (!mcpContext) return process.env;
	return {
		...process.env,
		...gitAuthorEnv(mcpContext.memberName),
		TEAMOS_TEAM_DIR: mcpContext.teamDir,
		TEAMOS_MEMBER_NAME: mcpContext.memberName,
		TEAMOS_MESSAGING_ADAPTER: mcpContext.messagingAdapterName || 'file',
		TEAMOS_TASKS_ADAPTER: mcpContext.tasksAdapterName || 'file',
		TEAMOS_SCHEDULE_ADAPTER: mcpContext.scheduleAdapterName || 'file',
		TEAMOS_TRIGGERS_ADAPTER: mcpContext.triggersAdapterName || 'file',
		TEAMOS_WATCHES_ADAPTER: mcpContext.watchesAdapterName || 'file',
	};
}

/**
 * Write prompt to a temp instruction file, spawn the agent, tee output to log. Returns exit code.
 * @param {string} agentName - Agent adapter name (claude, cursor, auggie)
 * @param {string} prompt - Full prompt text
 * @param {string} cwd - Working directory for the agent
 * @param {string} logFile - Path to write agent output log
 * @param {Object} [mcpContext] - Optional MCP context for messaging tools
 * @param {string} [mcpContext.teamDir] - Path to team/ directory
 * @param {string} [mcpContext.memberName] - Member name for this cycle
 * @param {Object} [options]
 * @param {{ sessionId: string, message: string }} [options.resume] - continue a session instead
 *   of starting a cycle (only for agentSupportsResume agents; `prompt` is still the system prompt)
 * @param {(sessionId: string) => void} [options.onSession] - told the session id once known
 */
export async function runAgent(agentName, prompt, cwd, logFile, mcpContext, { resume, onSession } = {}) {
	const adapter = agents[agentName];
	if (!adapter) {
		console.error(`Unknown agent: ${agentName}. Available: ${Object.keys(agents).join(', ')}`);
		process.exit(1);
	}

	const instructionFile = logFile.replace(/\.log$/, '.prompt.md');
	await writeFile(instructionFile, prompt, 'utf-8');

	if (resume && !agentSupportsResume(agentName)) throw new Error(`Agent ${agentName} cannot resume a session`);
	const adapterResult = adapter(instructionFile, prompt, { cwd, resume });
	const logStream = createWriteStream(logFile, { flags: 'a' });
	const { cmd, args, shellCmd, formatStream } = adapterResult;

	const spawnEnv = buildMcpEnv(mcpContext);
	const spawnArgs = shellCmd
		? [shellCmd, [], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true, env: spawnEnv }]
		: [cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: spawnEnv }];

	try {
		return await new Promise((resolve, reject) => {
			const child = spawn(...spawnArgs);
			let idleTimer = null;
			let resultExitCode = null;
			let settled = false;

			function settle(code) {
				if (settled) return;
				settled = true;
				clearTimeout(idleTimer);
				logStream.end(`\n[runner] Agent exited with code ${code}\n`);
				logStream.once('finish', () => resolve(code));
				logStream.once('error', () => resolve(code));
			}

			function resetIdleTimer() {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					const msg = `\n[runner] Agent idle for ${IDLE_TIMEOUT_MS / 60000}min — killing as hung.\n`;
					process.stderr.write(msg);
					logStream.write(msg);
					killTree(child);
				}, IDLE_TIMEOUT_MS);
			}

			resetIdleTimer();

			function writeOut(text) {
				process.stdout.write(text);
				if (!logStream.write(text)) {
					child.stdout.pause();
					logStream.once('drain', () => child.stdout.resume());
				}
			}

			function processLine(line) {
				if (!formatStream) {
					writeOut(`${line}\n`);
					return;
				}
				const result = formatStream(line);
				if (result.sessionId) onSession?.(result.sessionId);
				if (result.text) writeOut(result.text);
				if (result.done) {
					resultExitCode = result.exitCode ?? 0;
					clearTimeout(idleTimer);
					// Tree-kill on the `result` message rather than waiting for a
					// graceful exit. On Windows, Claude sometimes leaves MCP server
					// children (chrome-devtools-mcp, playwright-mcp, plus our own
					// teamos-tools mcp-server.mjs) running after a clean exit,
					// leaking ~150 MB each across many ticket runs and eventually
					// starving the system enough that the VS Code pty host crashes
					// and every terminal disconnects. taskkill /T /F walks the
					// descendants and reaps them while the parent PID is still
					// valid.
					killTree(child);
				}
			}

			let buf = '';
			child.stdout.on('data', (chunk) => {
				if (resultExitCode == null) resetIdleTimer();
				buf += chunk.toString();
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';
				for (const line of lines) processLine(line);
			});

			child.stderr.on('data', (chunk) => {
				if (resultExitCode == null) resetIdleTimer();
				process.stderr.write(chunk);
				logStream.write(chunk);
			});

			child.on('error', (err) => {
				const label = shellCmd ? 'agent' : cmd;
				console.error(`Failed to spawn ${label}: ${err.message}`);
				logStream.end(`\n[runner] Agent spawn error: ${err.message}\n`);
				logStream.once('finish', () => reject(err));
				logStream.once('error', () => reject(err));
			});

			child.on('close', (code) => {
				if (buf) processLine(buf.trimEnd());
				settle(resultExitCode ?? code ?? 1);
			});
		});
	} finally {
		process.stdout.write('\x1b[0m');
		await unlink(instructionFile).catch(() => {});
	}
}
