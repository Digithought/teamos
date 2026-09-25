import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchCodeVersion } from './code-version.mjs';

const fakeHead = (...shas) => { let i = 0; return () => shas[Math.min(i++, shas.length - 1)]; };

test('inert without a supervisor', () => {
	assert.equal(watchCodeVersion('.', { env: {}, head: fakeHead('a'.repeat(40)) }), null);
});

test('inert when the exit code is not a usable status', () => {
	for (const v of ['0', '256', 'x']) {
		assert.equal(watchCodeVersion('.', { env: { RUNNER_RESTART_EXIT_CODE: v }, head: fakeHead('a') }), null);
	}
});

test('inert when HEAD cannot be read at startup', () => {
	assert.equal(watchCodeVersion('.', { env: { RUNNER_RESTART_EXIT_CODE: '75' }, head: fakeHead(null) }), null);
});

test('reports a moved HEAD, ignoring an unreadable one', () => {
	const w = watchCodeVersion('.', { env: { RUNNER_RESTART_EXIT_CODE: '75' }, head: fakeHead('aaaaaaa1', 'aaaaaaa1', null, 'bbbbbbb2') });
	assert.equal(w.exitCode, 75);
	assert.equal(w.changed(), null);
	assert.equal(w.changed(), null);
	assert.deepEqual(w.changed(), { from: 'aaaaaaa', to: 'bbbbbbb' });
});

test('reads a real repository', () => {
	const w = watchCodeVersion(import.meta.dirname, { env: { RUNNER_RESTART_EXIT_CODE: '75' } });
	assert.ok(w);
	assert.equal(w.changed(), null);
});
