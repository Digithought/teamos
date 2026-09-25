import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentSupportsResume, gitAuthorEnv, runAgent } from './index.mjs';
import { createClaudeAdapter, formatClaudeJsonLine } from './claude.mjs';

/**
 * Spawn tests run against a stub `claude` on PATH. The `env` option runAgent
 * grew for chat (credentials for a second account) is what makes this possible
 * — spawn resolves the executable through the env it is handed.
 */
async function withStubAgent(script, fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-agent-'));
	const stub = join(dir, 'claude');
	await writeFile(stub, `#!/usr/bin/env node\n${script}\n`, 'utf-8');
	await chmod(stub, 0o755);
	// The adapter only passes --mcp-config when the file is really there.
	await writeFile(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');
	try {
		await fn({
			dir,
			env: { PATH: `${dir}:${process.env.PATH}`, TEAMOS_STUB_OUT: join(dir, 'argv.json') },
			logFile: join(dir, 'run.log'),
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('formatClaudeJsonLine emits structured events beside the log text', () => {
	const assistant = formatClaudeJsonLine(
		JSON.stringify({
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Read', input: { f: 'a' } }] },
		}),
	);
	assert.deepEqual(
		assistant.events.map((e) => e.kind),
		['text', 'tool'],
	);
	assert.equal(assistant.events[0].content, 'hello');
	assert.equal(assistant.events[1].content, 'Read');
	assert.match(assistant.text, /\[ASSISTANT\]/);

	const result = formatClaudeJsonLine(JSON.stringify({ type: 'result', is_error: false, result: 'done' }));
	assert.equal(result.done, true);
	assert.equal(result.exitCode, 0);
	assert.deepEqual(result.events, [{ kind: 'result', content: 'done' }]);

	assert.deepEqual(formatClaudeJsonLine('not json at all').events, []);
});

test('runAgent streams events, honours the env override, and cleans up the prompt file', async () => {
	const script = `
		const { writeFileSync } = require('node:fs');
		writeFileSync(process.env.TEAMOS_STUB_OUT, JSON.stringify(process.argv.slice(2)));
		process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] } }) + '\\n');
		process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'hi there' }) + '\\n');
	`;
	await withStubAgent(script, async ({ dir, env, logFile }) => {
		const events = [];
		const exitCode = await runAgent('claude', 'PROMPT BODY', dir, logFile, undefined, {
			env,
			quiet: true,
			onEvent: (event) => events.push(event),
			agentOptions: { task: 'say hi' },
		});

		assert.equal(exitCode, 0);
		assert.deepEqual(
			events.map((e) => e.kind),
			['text', 'result'],
		);
		assert.equal(events[0].content, 'hi there');

		const argv = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf-8'));
		// Every spawn gets the project's MCP servers and every built-in tool.
		// Chat used to strip both; the file tools' own read-before-write checks
		// make that unnecessary — see teamos/docs/chat.md.
		assert.ok(!argv.includes('--disallowed-tools'), 'no tool is denied to a chat spawn');
		assert.ok(argv.includes('--mcp-config'), "the project's .mcp.json is loaded explicitly");
		assert.equal(argv[argv.indexOf('--mcp-config') + 1], join(dir, '.mcp.json'));
		assert.equal(argv[argv.length - 1], 'say hi');

		// The prompt the agent was handed is written next to the log and removed
		// after the run; the log itself is kept.
		await assert.rejects(() => readFile(logFile.replace(/\.log$/, '.prompt.md'), 'utf-8'));
		assert.match(await readFile(logFile, 'utf-8'), /hi there/);
	});
});

test('runAgent kills the child when the caller aborts', async () => {
	// Writes its pid, then hangs: only a kill ends this run.
	const script = `
		const { writeFileSync } = require('node:fs');
		writeFileSync(process.env.TEAMOS_STUB_OUT, JSON.stringify(process.pid));
		setInterval(() => {}, 1000);
	`;
	await withStubAgent(script, async ({ dir, env, logFile }) => {
		const controller = new AbortController();
		const run = runAgent('claude', 'PROMPT BODY', dir, logFile, undefined, {
			env,
			quiet: true,
			signal: controller.signal,
		});

		// Wait for the stub to be up before aborting, so the kill has a target.
		let pid = null;
		for (let i = 0; i < 100 && pid === null; i++) {
			pid = await readFile(join(dir, 'argv.json'), 'utf-8')
				.then((raw) => JSON.parse(raw))
				.catch(() => null);
			if (pid === null) await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(pid, 'stub agent started');

		controller.abort();
		await run;

		// The promise settling means the child closed; confirm it is really gone
		// rather than reparented and still burning tokens.
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
	});
});

test('git author names the member; email only from the template', () => {
	assert.deepEqual(gitAuthorEnv('Devin', {}), { GIT_AUTHOR_NAME: 'Devin (teamos)' });
	assert.deepEqual(gitAuthorEnv('Devin', { TEAMOS_GIT_AUTHOR_EMAIL: '{member}@example.com' }), {
		GIT_AUTHOR_NAME: 'Devin (teamos)',
		GIT_AUTHOR_EMAIL: 'devin@example.com',
	});
	assert.deepEqual(gitAuthorEnv(undefined, {}), {});
});

test('only claude resumes', () => {
	assert.equal(agentSupportsResume('claude'), true);
	assert.equal(agentSupportsResume('cursor'), false);
});

test('claude adapter: fresh cycle vs resumed session', () => {
	const fresh = createClaudeAdapter('/tmp/p.md', '', {}).args;
	assert.ok(!fresh.includes('--resume'));
	assert.ok(!fresh.includes('--no-session-persistence'));
	assert.match(fresh.at(-1), /Execute the member cycle/);
	const resumed = createClaudeAdapter('/tmp/p.md', '', { resume: { sessionId: 'abc', message: 'clean up' } }).args;
	assert.deepEqual(resumed.slice(resumed.indexOf('--resume'), resumed.indexOf('--resume') + 2), ['--resume', 'abc']);
	assert.equal(resumed.at(-1), 'clean up');
});

test('init line yields the session id', () => {
	assert.equal(formatClaudeJsonLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })).sessionId, 's1');
});
