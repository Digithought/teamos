import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Format Claude stream-json lines to readable text.
 * Returns { text, done? } — when done is true the agent has emitted its
 * final result and the runner should stop waiting for a clean exit.
 */
export function formatClaudeJsonLine(line) {
	try {
		const obj = JSON.parse(line);
		if (obj.type === 'system') {
			if (obj.subtype === 'init') {
				return { text: `[session ${obj.session_id ?? '?'}]\n` };
			}
			// thinking_tokens (and any future progress-only system event):
			// collapse to a single dot so the log shows a thinking heartbeat
			// rather than a stream of raw JSON.
			return { text: '.' };
		}
		if (obj.type === 'assistant') {
			const content = obj.message?.content ?? [];
			const parts = [];
			for (const block of content) {
				if (block.type === 'text' && block.text) {
					parts.push(`\n[ASSISTANT]\n${block.text}\n`);
				} else if (block.type === 'tool_use') {
					const inputStr =
						typeof block.input === 'object' ? JSON.stringify(block.input).slice(0, 200) : String(block.input ?? '');
					parts.push(`\n[TOOL:${block.name}] ${inputStr}\n`);
				}
			}
			return { text: parts.join('') || '' };
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
			return { text: parts.join('') || '' };
		}
		if (obj.type === 'result') {
			const status = obj.is_error ? 'ERROR' : 'DONE';
			const cost = obj.total_cost_usd != null ? ` | cost $${obj.total_cost_usd.toFixed(4)}` : '';
			const dur = obj.duration_ms != null ? ` | ${(obj.duration_ms / 1000).toFixed(1)}s` : '';
			return {
				text: `\n[RESULT ${status}${dur}${cost}]\n${obj.result ?? ''}\n`,
				done: true,
				exitCode: obj.is_error ? 1 : 0,
			};
		}
	} catch {
		/* not JSON, pass through */
	}
	const text = line.endsWith('\n') ? line : `${line}\n`;
	return { text };
}

/**
 * Claude CLI agent adapter.
 * Returns { cmd, args, formatStream } for spawning.
 */
export function createClaudeAdapter(instructionFile, _prompt, { cwd } = {}) {
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
			'--no-session-persistence',
			'--output-format',
			'stream-json',
			'--effort',
			'xhigh',
			...(mcpConfig && existsSync(mcpConfig) ? ['--mcp-config', mcpConfig] : []),
			'--append-system-prompt-file',
			instructionFile,
			'Execute the member cycle as described in the appended system prompt.',
		],
		formatStream: formatClaudeJsonLine,
	};
}
