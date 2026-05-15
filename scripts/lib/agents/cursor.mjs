import { relative } from 'node:path';

export function formatCursorJsonLine(line) {
	try {
		const obj = JSON.parse(line);
		if (obj.type === 'user') {
			const t = obj.message?.content?.[0]?.text ?? '';
			return { text: `\n[USER]\n${t}\n` };
		}
		if (obj.type === 'assistant') {
			const t = obj.message?.content?.[0]?.text ?? '';
			return { text: `\n[ASSISTANT]\n${t}\n` };
		}
		if (obj.type === 'tool_call' && obj.subtype === 'started') {
			const tc = obj.tool_call ?? {};
			if (tc.shellToolCall) return { text: `\n[SHELL] ${tc.shellToolCall.args?.command ?? ''}\n` };
			if (tc.readToolCall) return { text: `\n[READ] ${tc.readToolCall.args?.path ?? ''}\n` };
			if (tc.editToolCall) return { text: `\n[EDIT] ${tc.editToolCall.args?.path ?? ''}\n` };
			if (tc.writeToolCall) return { text: `\n[WRITE] ${tc.writeToolCall.args?.path ?? ''}\n` };
			if (tc.grepToolCall)
				return { text: `\n[GREP] ${tc.grepToolCall.args?.pattern ?? ''} in ${tc.grepToolCall.args?.path ?? ''}\n` };
			if (tc.lsToolCall) return { text: `\n[LS] ${tc.lsToolCall.args?.path ?? ''}\n` };
			if (tc.deleteToolCall) return { text: `\n[DELETE] ${tc.deleteToolCall.args?.path ?? ''}\n` };
			return { text: `\n[TOOL] ${Object.keys(tc)[0] ?? '?'}\n` };
		}
		if (obj.type === 'tool_call' && obj.subtype === 'completed') {
			const tc = obj.tool_call ?? {};
			const ok = (r) => r?.success != null;
			if (tc.shellToolCall)
				return {
					text: ok(tc.shellToolCall.result)
						? `  > exit ${tc.shellToolCall.result.success?.exitCode ?? 0}\n`
						: '  > failed\n',
				};
			if (tc.readToolCall)
				return {
					text: ok(tc.readToolCall.result)
						? `  > read ${tc.readToolCall.result.success?.totalLines ?? 0} lines\n`
						: '  > failed\n',
				};
			if (tc.editToolCall || tc.writeToolCall || tc.deleteToolCall)
				return { text: ok(Object.values(tc)[0]?.result) ? '  > done\n' : '  > failed\n' };
			return { text: '  > done\n' };
		}
	} catch {
		/* not JSON, pass through */
	}
	const text = line.endsWith('\n') ? line : `${line}\n`;
	return { text };
}

/**
 * Cursor agent adapter.
 * Returns { shellCmd, formatStream } for spawning.
 */
export function createCursorAdapter(instructionFile, _prompt, { cwd }) {
	const relPath = relative(cwd, instructionFile).replace(/\\/g, '/');
	const prompt = `Read and follow all instructions in the file: ${relPath}`;
	return {
		shellCmd: `agent --print -f --trust --output-format stream-json --workspace "${cwd}" "${prompt}"`,
		formatStream: formatCursorJsonLine,
	};
}
