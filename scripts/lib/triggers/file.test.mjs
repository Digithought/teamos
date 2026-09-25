import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { FileTriggersAdapter } from './file.mjs';

const execFileAsync = promisify(execFile);

async function git(repoRoot, args) {
	const { stdout } = await execFileAsync('git', args, { cwd: repoRoot });
	return stdout.trim();
}

async function initRepo(repoRoot) {
	await git(repoRoot, ['init', '-q', '-b', 'main']);
	await git(repoRoot, ['config', 'user.email', 'test@example.com']);
	await git(repoRoot, ['config', 'user.name', 'Test']);
	await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
	await git(repoRoot, ['commit', '--allow-empty', '-q', '-m', 'root']);
}

/** Commit as `author`, touching each key of `files` (default: an empty commit). Returns the new SHA. */
async function commit(repoRoot, { message, author = 'Test', files = {} }) {
	for (const [path, content] of Object.entries(files)) {
		const full = join(repoRoot, path);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, content);
		await git(repoRoot, ['add', path]);
	}
	const args = ['commit', '-q', '-m', message, `--author=${author} <${author}@example.com>`];
	if (Object.keys(files).length === 0) args.splice(1, 0, '--allow-empty');
	await git(repoRoot, args);
	return git(repoRoot, ['rev-parse', 'HEAD']);
}

async function withAdapter(fn) {
	const repoRoot = await mkdtemp(join(tmpdir(), 'teamos-triggers-'));
	try {
		await initRepo(repoRoot);
		const teamDir = join(repoRoot, 'team');
		const adapter = new FileTriggersAdapter(teamDir, repoRoot);
		await fn(adapter, repoRoot, teamDir);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
}

test('addTrigger anchors the cursor at HEAD — no backfill of prior history', async () => {
	await withAdapter(async (adapter, repoRoot) => {
		await commit(repoRoot, { message: 'pre-existing', author: 'bob', files: { 'a.txt': 'x' } });
		await adapter.addTrigger('alice', { priority: 'today' });
		assert.deepEqual(await adapter.pendingMatches('alice'), []);
	});
});

test('a new matching commit appears in pendingMatches', async () => {
	await withAdapter(async (adapter, repoRoot) => {
		await adapter.addTrigger('alice', { priority: 'today', paths: ['src/**'] });
		await commit(repoRoot, { message: 'touch src', author: 'bob', files: { 'src/a.ts': 'x' } });
		const matches = await adapter.pendingMatches('alice');
		assert.equal(matches.length, 1);
		assert.equal(matches[0].subject, 'touch src');
		assert.equal(matches[0].priority, 'today');
	});
});

test('commits authored by the member are skipped by default', async () => {
	await withAdapter(async (adapter, repoRoot) => {
		await adapter.addTrigger('alice', { priority: 'today' });
		await commit(repoRoot, { message: 'self', author: 'alice' });
		assert.deepEqual(await adapter.pendingMatches('alice'), []);
	});
});

test('a match stays durable across repeated pendingMatches calls until explicitly cleared — regression test for the 2026-09-25 permanent-loss bug', async () => {
	await withAdapter(async (adapter, repoRoot) => {
		await adapter.addTrigger('alice', { priority: 'today' });
		await commit(repoRoot, { message: 'work', author: 'bob' });

		// First call — e.g. the cycle prompt where the match is shown but the
		// agent's actual work that cycle goes elsewhere (an inbox reply, say).
		const first = await adapter.pendingMatches('alice');
		assert.equal(first.length, 1);

		// Before this fix, the scan cursor had already advanced past this commit
		// on the first call, so a second call — an unrelated cycle later in the
		// same pass, or the next pass entirely — silently returned []. That is
		// the permanent-loss shape: the match never reappears, and nobody who
		// didn't already read the first cycle's prompt ever sees it.
		const second = await adapter.pendingMatches('alice');
		assert.equal(second.length, 1);
		assert.equal(second[0].hash, first[0].hash);

		// It also survives an intervening unrelated commit landing afterward.
		await commit(repoRoot, { message: 'unrelated', author: 'carol' });
		const third = await adapter.pendingMatches('alice');
		assert.equal(third.length, 2);
	});
});

test('hasPendingMatches reflects the durable ledger, not just the newest scan', async () => {
	await withAdapter(async (adapter, repoRoot) => {
		await adapter.addTrigger('alice', { priority: 'thisWeek' });
		await commit(repoRoot, { message: 'work', author: 'bob' });
		await adapter.pendingMatches('alice'); // first scan, matches recorded to the ledger
		assert.equal(await adapter.hasPendingMatches('alice', 'thisWeek'), true);
		assert.equal(await adapter.hasPendingMatches('alice', 'today'), false);
	});
});

test('clearMatches({ triggerId }) clears the whole current batch for that trigger', async () => {
	await withAdapter(async (adapter, repoRoot) => {
		const { id } = await adapter.addTrigger('alice', { priority: 'today' });
		await commit(repoRoot, { message: 'one', author: 'bob' });
		await commit(repoRoot, { message: 'two', author: 'bob' });
		assert.equal((await adapter.pendingMatches('alice')).length, 2);

		const { cleared } = await adapter.clearMatches('alice', { triggerId: id });
		assert.equal(cleared, 2);
		assert.deepEqual(await adapter.pendingMatches('alice'), []);
	});
});

test('clearMatches({ hashes }) clears specific commits outright', async () => {
	await withAdapter(async (adapter, repoRoot) => {
		await adapter.addTrigger('alice', { priority: 'today' });
		await commit(repoRoot, { message: 'one', author: 'bob' });
		const twoHash = await commit(repoRoot, { message: 'two', author: 'bob' });
		await adapter.pendingMatches('alice');

		const { cleared } = await adapter.clearMatches('alice', { hashes: [twoHash] });
		assert.equal(cleared, 1);
		const remaining = await adapter.pendingMatches('alice');
		assert.equal(remaining.length, 1);
		assert.equal(remaining[0].subject, 'one');
	});
});

test('clearing one trigger leaves a commit visible for a different trigger that also matched it', async () => {
	await withAdapter(async (adapter, repoRoot) => {
		const t1 = await adapter.addTrigger('alice', { priority: 'today', reason: 'first' });
		const t2 = await adapter.addTrigger('alice', { priority: 'later', reason: 'second' });
		await commit(repoRoot, { message: 'shared', author: 'bob' });

		const matches = await adapter.pendingMatches('alice');
		assert.equal(matches.length, 1);
		assert.deepEqual(matches[0].matchedTriggerIds.slice().sort(), [t1.id, t2.id].sort());
		assert.equal(matches[0].priority, 'today'); // best of the two

		await adapter.clearMatches('alice', { triggerId: t1.id });
		const remaining = await adapter.pendingMatches('alice');
		assert.equal(remaining.length, 1);
		assert.deepEqual(remaining[0].matchedTriggerIds, [t2.id]);
		assert.equal(remaining[0].priority, 'later'); // recomputed after narrowing
	});
});

test('removeTrigger drops its share of ledger matches but not a co-matching trigger\'s share', async () => {
	await withAdapter(async (adapter, repoRoot) => {
		const t1 = await adapter.addTrigger('alice', { priority: 'today' });
		const t2 = await adapter.addTrigger('alice', { priority: 'later' });
		await commit(repoRoot, { message: 'shared', author: 'bob' });
		await adapter.pendingMatches('alice');

		await adapter.removeTrigger('alice', t1.id);
		const remaining = await adapter.pendingMatches('alice');
		assert.equal(remaining.length, 1);
		assert.deepEqual(remaining[0].matchedTriggerIds, [t2.id]);
	});
});

test('a pre-split triggers.json with an inline cursor migrates without re-scanning already-passed history', async () => {
	await withAdapter(async (adapter, repoRoot, teamDir) => {
		const passedHash = await commit(repoRoot, { message: 'already scanned', author: 'bob' });
		const legacyPath = join(teamDir, 'members', 'alice', 'triggers.json');
		await mkdir(dirname(legacyPath), { recursive: true });
		await writeFile(
			legacyPath,
			JSON.stringify({ cursor: passedHash, items: [{ id: 'legacy-1', priority: 'today' }] }),
		);

		// Nothing new since the legacy cursor — and definitely not the commit it
		// already scanned past.
		assert.deepEqual(await adapter.pendingMatches('alice'), []);

		// triggers.json is rewritten to hold only items — no cursor field.
		const rewritten = JSON.parse(await readFile(legacyPath, 'utf-8'));
		assert.equal('cursor' in rewritten, false);
		assert.deepEqual(rewritten.items.map((i) => i.id), ['legacy-1']);

		// The migrated cursor lands in the new ledger file.
		const ledgerRaw = JSON.parse(await readFile(join(teamDir, '.logs', 'triggers', 'alice.json'), 'utf-8'));
		assert.equal(ledgerRaw.cursor, passedHash);

		// A genuinely new commit is still scanned correctly post-migration.
		await commit(repoRoot, { message: 'after migration', author: 'bob' });
		const matches = await adapter.pendingMatches('alice');
		assert.equal(matches.length, 1);
		assert.equal(matches[0].subject, 'after migration');
	});
});

test('pendingMatches returns durable matches even when HEAD cannot be read', async () => {
	await withAdapter(async (adapter, repoRoot) => {
		await adapter.addTrigger('alice', { priority: 'today' });
		await commit(repoRoot, { message: 'work', author: 'bob' });
		const first = await adapter.pendingMatches('alice');
		assert.equal(first.length, 1);

		await rm(join(repoRoot, '.git'), { recursive: true, force: true });
		const second = await adapter.pendingMatches('alice');
		assert.equal(second.length, 1);
	});
});

test('clearMatches rejects an empty selector and an unknown triggerId', async () => {
	await withAdapter(async (adapter) => {
		await assert.rejects(() => adapter.clearMatches('alice', {}), /pass `triggerId`, `hashes`, or both/);
		await assert.rejects(() => adapter.clearMatches('alice', { triggerId: 'nope' }), /is not in alice's triggers/);
	});
});

test('a member with no triggers never scans and always reports empty', async () => {
	await withAdapter(async (adapter, repoRoot) => {
		await commit(repoRoot, { message: 'noise', author: 'bob' });
		assert.deepEqual(await adapter.pendingMatches('alice'), []);
		assert.equal(await adapter.hasPendingMatches('alice', 'later'), false);
	});
});
