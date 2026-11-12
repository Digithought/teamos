import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acknowledgeMemos, buildMemosSection, classifyMemo, hasUnseenMemos, readMemoMark } from './memos.mjs';

const T1 = '2026-11-10T00:00:00.000Z';
const T2 = '2026-11-11T00:00:00.000Z';
const T3 = '2026-11-12T00:00:00.000Z';
const at = (iso) => Date.parse(iso);

async function withMemos(items, fn) {
	const teamDir = await mkdtemp(join(tmpdir(), 'teamos-memos-'));
	try {
		await writeFile(join(teamDir, 'memos.json'), JSON.stringify({ items }), 'utf-8');
		await fn(teamDir);
	} finally {
		await rm(teamDir, { recursive: true, force: true });
	}
}

test('classifyMemo: new after the mark, revised when only the edit is after it, seen otherwise', () => {
	assert.equal(classifyMemo({ postedAt: T2 }, null, 'alice'), 'new');
	assert.equal(classifyMemo({ postedAt: T2 }, at(T1), 'alice'), 'new');
	assert.equal(classifyMemo({ postedAt: T1 }, at(T2), 'alice'), 'seen');
	assert.equal(classifyMemo({ postedAt: T1, revisedAt: T3 }, at(T2), 'alice'), 'revised');
	assert.equal(classifyMemo({ postedAt: T2, authorName: 'Alice' }, null, 'alice'), 'seen');
	assert.equal(classifyMemo({ postedAt: 'garbage' }, null, 'alice'), 'seen');
});

test('buildMemosSection shows unseen memos in full, seen ones by title, and reports what it showed', async () => {
	await withMemos(
		[
			{ title: 'Old news', content: 'OLD BODY', postedAt: T1, importance: 'low' },
			{ title: 'Fresh news', content: 'FRESH BODY', postedAt: T3, importance: 'high' },
		],
		async (teamDir) => {
			await acknowledgeMemos(teamDir, 'alice', at(T2));
			const { text, through } = await buildMemosSection(teamDir, 'alice');
			assert.match(text, /### \[NEW\] Fresh news/);
			assert.match(text, /FRESH BODY/);
			assert.match(text, /- Old news/);
			assert.doesNotMatch(text, /OLD BODY/);
			assert.equal(through, at(T3));
		},
	);
});

test('acknowledgeMemos advances the mark, never backwards, and a seen memo stops being marked', async () => {
	await withMemos([{ title: 'A', content: 'x', postedAt: T2, importance: 'high' }], async (teamDir) => {
		assert.equal(await readMemoMark(teamDir, 'alice'), null);
		await acknowledgeMemos(teamDir, 'alice', at(T2));
		await acknowledgeMemos(teamDir, 'alice', at(T1));
		assert.equal(await readMemoMark(teamDir, 'alice'), at(T2));
		const { text } = await buildMemosSection(teamDir, 'alice');
		assert.doesNotMatch(text, /\[NEW\]/);
		// Other members keep their own mark.
		assert.match((await buildMemosSection(teamDir, 'bob')).text, /\[NEW\] A/);
	});
});

test('hasUnseenMemos wakes for high at today and critical at pressing only, until acknowledged', async () => {
	await withMemos(
		[
			{ title: 'H', content: '', postedAt: T2, importance: 'high' },
			{ title: 'M', content: '', postedAt: T3, importance: 'medium' },
		],
		async (teamDir) => {
			assert.equal(await hasUnseenMemos(teamDir, 'alice', 'pressing'), false);
			assert.equal(await hasUnseenMemos(teamDir, 'alice', 'today'), true);
			await acknowledgeMemos(teamDir, 'alice', at(T2));
			// Only the medium memo is unseen now, and medium wakes no one.
			assert.equal(await hasUnseenMemos(teamDir, 'alice', 'later'), false);
		},
	);
	await withMemos([{ title: 'C', content: '', postedAt: T2, importance: 'critical' }], async (teamDir) => {
		assert.equal(await hasUnseenMemos(teamDir, 'alice', 'pressing'), true);
	});
});
