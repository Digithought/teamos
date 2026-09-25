import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCleanupPrompt, leftoversSince, parseStatusZ, snapshotDirty } from './leftovers.mjs';

function repo() {
	const dir = mkdtempSync(join(tmpdir(), 'leftovers-'));
	const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
	g('init', '-q');
	g('config', 'user.email', 't@t');
	g('config', 'user.name', 't');
	writeFileSync(join(dir, 'a.txt'), 'a\n');
	writeFileSync(join(dir, 'b.txt'), 'b\n');
	g('add', '.');
	g('commit', '-qm', 'init');
	return dir;
}

test('parses porcelain -z, skipping a rename source', () => {
	assert.deepEqual(parseStatusZ(' M a\0R  new\0old\0?? c d\0'), [
		{ code: ' M', path: 'a' },
		{ code: 'R ', path: 'new' },
		{ code: '??', path: 'c d' },
	]);
});

test('attributes only what changed during the cycle', () => {
	const dir = repo();
	try {
		writeFileSync(join(dir, 'a.txt'), 'someone else, earlier\n');
		mkdirSync(join(dir, 'team'));
		const before = snapshotDirty(dir, join(dir, 'team'));
		writeFileSync(join(dir, 'b.txt'), 'member edit\n');
		writeFileSync(join(dir, 'new.txt'), 'member file\n');
		writeFileSync(join(dir, 'team', 'state.json'), '{}');
		const after = snapshotDirty(dir, join(dir, 'team'));
		assert.deepEqual(
			leftoversSince(before, after).map((l) => l.path).sort(),
			['b.txt', 'new.txt'],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a pre-existing dirty file counts once the member changes it further', () => {
	const dir = repo();
	try {
		writeFileSync(join(dir, 'a.txt'), 'earlier\n');
		const before = snapshotDirty(dir);
		writeFileSync(join(dir, 'a.txt'), 'earlier, then the member\n');
		assert.deepEqual(leftoversSince(before, snapshotDirty(dir)), [{ path: 'a.txt', status: ' M' }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a clean cycle, or one that cleaned up, leaves nothing', () => {
	const dir = repo();
	try {
		writeFileSync(join(dir, 'a.txt'), 'dirty\n');
		const before = snapshotDirty(dir);
		execFileSync('git', ['checkout', '--', 'a.txt'], { cwd: dir });
		assert.deepEqual(leftoversSince(before, snapshotDirty(dir)), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('outside a git work tree the check is off', () => {
	const dir = mkdtempSync(join(tmpdir(), 'leftovers-nogit-'));
	try {
		assert.equal(snapshotDirty(dir), null);
		assert.deepEqual(leftoversSince(null, null), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('cleanup prompt lists paths and caps a long list', () => {
	const many = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}`, status: '??' }));
	const p = buildCleanupPrompt(many, { limit: 3 });
	assert.match(p, /\?\? f0/);
	assert.doesNotMatch(p, /f3/);
	assert.match(p, /and 2 more/);
});
