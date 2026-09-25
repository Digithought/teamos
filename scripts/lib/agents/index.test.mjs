import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentSupportsResume, gitAuthorEnv } from './index.mjs';
import { createClaudeAdapter, formatClaudeJsonLine } from './claude.mjs';

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
