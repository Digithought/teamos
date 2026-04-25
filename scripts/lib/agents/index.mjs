import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeAdapter } from './claude.mjs';
import { createCursorAdapter } from './cursor.mjs';
import { createAuggieAdapter } from './auggie.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes with no output → assume hung

/** Path to the MCP server script. */
const MCP_SERVER_PATH = join(__dirname, '..', 'messaging', 'mcp-server.mjs');

/** Agent adapter registry. */
const agents = {
	claude: createClaudeAdapter,
	cursor: createCursorAdapter,
	auggie: createAuggieAdapter,
};

/** Get list of available agent names. */
export function getAvailableAgents() {
	return Object.keys(agents);
}

/**
 * Write a temporary .mcp.json so the Claude CLI discovers the messaging MCP server.
 * Returns the path so it can be cleaned up after the agent exits.
 */
async function writeMcpConfig(cwd, mcpContext) {
	const mcpConfigPath = join(cwd, '.mcp.json');

	// Preserve any existing .mcp.json content
	let existing = {};
	try {
		existing = JSON.parse(await readFile(mcpConfigPath, 'utf-8'));
	} catch {
		/* no existing file */
	}

	const config = {
		...existing,
		mcpServers: {
			...(existing.mcpServers || {}),
			'teamos-tools': {
				type: 'stdio',
				command: 'node',
				args: [MCP_SERVER_PATH],
				env: {
					TEAMOS_TEAM_DIR: mcpContext.teamDir,
					TEAMOS_MEMBER_NAME: mcpContext.memberName,
					TEAMOS_MESSAGING_ADAPTER: mcpContext.messagingAdapterName || 'file',
					TEAMOS_TASKS_ADAPTER: mcpContext.tasksAdapterName || 'file',
					TEAMOS_SCHEDULE_ADAPTER: mcpContext.scheduleAdapterName || 'file',
					TEAMOS_TRIGGERS_ADAPTER: mcpContext.triggersAdapterName || 'file',
				},
			},
		},
	};

	await writeFile(mcpConfigPath, JSON.stringify(config, null, '\t') + '\n', 'utf-8');
	return { path: mcpConfigPath, hadExisting: Object.keys(existing).length > 0, original: existing };
}

/**
 * Clean up the temporary .mcp.json after the agent exits.
 * If there was pre-existing content, restore it; otherwise delete the file.
 */
async function cleanupMcpConfig(mcpState) {
	if (!mcpState) return;
	try {
		if (mcpState.hadExisting) {
			// Restore original content (minus our injected server)
			const restored = { ...mcpState.original };
			if (restored.mcpServers) {
				delete restored.mcpServers['teamos-tools'];
				delete restored.mcpServers['teamos-messaging'];
			}
			await writeFile(mcpState.path, JSON.stringify(restored, null, '\t') + '\n', 'utf-8');
		} else {
			await unlink(mcpState.path);
		}
	} catch {
		/* best effort */
	}
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
 */
export async function runAgent(agentName, prompt, cwd, logFile, mcpContext) {
	const adapter = agents[agentName];
	if (!adapter) {
		console.error(`Unknown agent: ${agentName}. Available: ${Object.keys(agents).join(', ')}`);
		process.exit(1);
	}

	const instructionFile = logFile.replace(/\.log$/, '.prompt.md');
	await writeFile(instructionFile, prompt, 'utf-8');

	// Set up MCP config if messaging context provided
	let mcpState = null;
	if (mcpContext && agentName === 'claude') {
		mcpState = await writeMcpConfig(cwd, mcpContext);
	}

	const adapterResult = adapter(instructionFile, prompt, { cwd });
	const logStream = createWriteStream(logFile, { flags: 'a' });
	const { cmd, args, shellCmd, formatStream } = adapterResult;

	const spawnArgs = shellCmd
		? [shellCmd, [], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true }]
		: [cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false }];

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
					child.kill();
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
					writeOut(line + '\n');
					return;
				}
				const result = formatStream(line);
				if (result.text) writeOut(result.text);
				if (result.done) {
					resultExitCode = result.exitCode ?? 0;
					clearTimeout(idleTimer);
					idleTimer = setTimeout(() => {
						const msg = `\n[runner] Agent sent result but didn't exit — killing stale process.\n`;
						process.stderr.write(msg);
						logStream.write(msg);
						child.kill();
					}, 30_000);
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
		await cleanupMcpConfig(mcpState);
	}
}
