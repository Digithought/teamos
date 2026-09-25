import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Format Claude stream-json lines to readable text.
 * Returns { text, done?, events? } — when done is true the agent has emitted
 * its final result and the runner should stop waiting for a clean exit.
 *
 * `text` is the log rendering and is what the runner tees. `events` is the
 * same line without the log decoration, for callers that render the stream
 * themselves (the dashboard chat pane) instead of appending it to a cycle log.
 * An adapter that omits `events` simply produces no structured events.
 */
export function formatClaudeJsonLine(line) {
	try {
		const obj = JSON.parse(line);
		if (obj.type === 'system') {
			if (obj.subtype === 'init') {
				return { text: `[session ${obj.session_id ?? '?'}]\n`, sessionId: obj.session_id, events: [] };
			}
			// thinking_tokens (and any future progress-only system event):
			// collapse to a single dot so the log shows a thinking heartbeat
			// rather than a stream of raw JSON.
			return { text: '.', events: [{ kind: 'thinking' }] };
		}
		if (obj.type === 'assistant') {
			const content = obj.message?.content ?? [];
			const parts = [];
			const events = [];
			for (const block of content) {
				if (block.type === 'text' && block.text) {
					parts.push(`\n[ASSISTANT]\n${block.text}\n`);
					events.push({ kind: 'text', content: block.text });
				} else if (block.type === 'tool_use') {
					const inputStr =
						typeof block.input === 'object' ? JSON.stringify(block.input).slice(0, 200) : String(block.input ?? '');
					parts.push(`\n[TOOL:${block.name}] ${inputStr}\n`);
					events.push({ kind: 'tool', content: block.name, detail: inputStr });
				}
			}
			return { text: parts.join('') || '', events };
		}
		if (obj.type === 'user') {
			const content = obj.message?.content ?? [];
			const parts = [];
			for (const block of content) {
				if (block.type === 'tool_result') {
					const text = Array.isArray(block.content)
						? block.content.map((c) => c.text ?? '').join('')
						: String(block.content ?? '');
					parts.push(`  > ${text.slice(0, 200)}\n`);
				} else if (block.type === 'text' && block.text) {
					parts.push(`\n[USER]\n${block.text}\n`);
				}
			}
			return { text: parts.join('') || '', events: [] };
		}
		if (obj.type === 'result') {
			const status = obj.is_error ? 'ERROR' : 'DONE';
			const cost = obj.total_cost_usd != null ? ` | cost $${obj.total_cost_usd.toFixed(4)}` : '';
			const dur = obj.duration_ms != null ? ` | ${(obj.duration_ms / 1000).toFixed(1)}s` : '';
			return {
				text: `\n[RESULT ${status}${dur}${cost}]\n${obj.result ?? ''}\n`,
				done: true,
				exitCode: obj.is_error ? 1 : 0,
				events: [{ kind: 'result', content: obj.result ?? '' }],
			};
		}
	} catch {
		/* not JSON, pass through */
	}
	const text = line.endsWith('\n') ? line : `${line}\n`;
	return { text, events: [] };
}

/**
 * Claude CLI agent adapter.
 * Returns { cmd, args, formatStream } for spawning.
 *
 * Every spawn — cycle, clerk or chat — gets the same tools. Chat used to pass
 * `mcp: false` plus a `--disallowed-tools` list to stop a conversation racing a
 * concurrent cycle; the CLI's own file tools already catch that (Edit needs a
 * prior Read and fails on a changed `old_string`, Write refuses a file it has
 * not read), so the restriction bought nothing the tools did not already give.
 * See `teamos/docs/chat.md`.
 *
 * @param {string} instructionFile - Path to the appended system prompt
 * @param {string} _prompt - Full prompt text (unused; the CLI reads the file)
 * @param {Object} [options]
 * @param {string} [options.cwd] - Working directory; also where `.mcp.json` is looked up
 * @param {string} [options.task] - The trailing prompt line; defaults to the cycle framing.
 * @param {{ sessionId: string, message: string }} [options.resume] - Continue that session with
 *   `resume.message` instead of starting a cycle (the runner's leftover check uses this).
 */
export function createClaudeAdapter(instructionFile, _prompt, { cwd, task, resume } = {}) {
	// Load the project's `.mcp.json` explicitly rather than relying on the
	// CLI's project-scope auto-discovery, whose approval rules (trust dialog,
	// `enabledMcpjsonServers` in a gitignored settings.local.json) have varied
	// across CLI versions — a cycle without it silently loses teamos-tools and
	// any other project server. `--mcp-config` is variadic, so it must precede
	// another flag rather than the trailing prompt string.
	const mcpConfig = cwd ? join(cwd, '.mcp.json') : null;
	return {
		cmd: 'claude',
		args: [
			'-p',
			'--dangerously-skip-permissions',
			'--verbose',
			// Sessions persist so the runner can resume one; Claude Code prunes them after
			// cleanupPeriodDays (30 by default).
			...(resume ? ['--resume', resume.sessionId] : []),
			'--output-format',
			'stream-json',
			'--effort',
			'xhigh',
			...(mcpConfig && existsSync(mcpConfig) ? ['--mcp-config', mcpConfig] : []),
			'--append-system-prompt-file',
			instructionFile,
			resume ? resume.message : (task ?? 'Execute the member cycle as described in the appended system prompt.'),
		],
		formatStream: formatClaudeJsonLine,
	};
}
