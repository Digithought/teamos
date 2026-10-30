import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCyclePrompt, STATE_BUDGET_BYTES, stateBudgetWarning } from './cycle.mjs';
import { FileMessagingAdapter } from './messaging/file.mjs';

test('stateBudgetWarning is null at and under the budget, present over it', () => {
	assert.equal(stateBudgetWarning(STATE_BUDGET_BYTES), null);
	assert.equal(stateBudgetWarning(STATE_BUDGET_BYTES - 1), null);
	assert.equal(stateBudgetWarning(0), null);

	const warning = stateBudgetWarning(STATE_BUDGET_BYTES + 1024);
	assert.match(warning, /state\.md is 17\.0 KB, over the 16 KB budget/);
	assert.match(warning, /archives\/state-history/);
	assert.match(warning, /team\/docs\/<topic>/);
});

/** A minimal team dir: org/memos/projects/members docs plus one member's profile+state. */
async function withTeam(stateContent, fn) {
	const teamDir = await mkdtemp(join(tmpdir(), 'teamos-cycle-'));
	try {
		await writeFile(join(teamDir, 'org.md'), '# Org\n', 'utf-8');
		await writeFile(join(teamDir, 'memos.json'), '{}', 'utf-8');
		await writeFile(join(teamDir, 'projects.json'), '{}', 'utf-8');
		await writeFile(join(teamDir, 'members.json'), '{}', 'utf-8');
		const memberDir = join(teamDir, 'members', 'alice');
		await mkdir(memberDir, { recursive: true });
		await writeFile(join(memberDir, 'profile.md'), '# Alice\n', 'utf-8');
		await writeFile(join(memberDir, 'state.md'), stateContent, 'utf-8');
		await fn(teamDir);
	} finally {
		await rm(teamDir, { recursive: true, force: true });
	}
}

test('buildCyclePrompt carries the state-budget warning only when state.md is actually over budget', async () => {
	const member = { name: 'alice', title: 'Tester' };

	await withTeam('## Focus\n\nAll good, small file.\n', async (teamDir) => {
		const adapters = { messaging: new FileMessagingAdapter(teamDir) };
		const { prompt } = await buildCyclePrompt(member, 'today', teamDir, adapters);
		assert.doesNotMatch(prompt, /over the 16 KB budget/);
		assert.match(prompt, /All good, small file\./);
	});

	await withTeam('x'.repeat(STATE_BUDGET_BYTES + 1), async (teamDir) => {
		const adapters = { messaging: new FileMessagingAdapter(teamDir) };
		const { prompt } = await buildCyclePrompt(member, 'today', teamDir, adapters);
		assert.match(prompt, /state\.md is .* KB, over the 16 KB budget/);
		// The warning sits inside "## Your Current State", ahead of the state content itself.
		const stateHeadingIdx = prompt.indexOf('## Your Current State');
		const warningIdx = prompt.indexOf('over the 16 KB budget');
		assert.ok(stateHeadingIdx !== -1 && warningIdx > stateHeadingIdx);
	});
});
