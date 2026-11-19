import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClaudeAdapter } from './agents/claude.mjs';
import { cycleEffort, parseProfileSettings, resolveBaseSettings } from './effort.mjs';
import { FileMessagingAdapter } from './messaging/file.mjs';
import { FileScheduleAdapter } from './schedule/file.mjs';
import { FileTasksAdapter } from './tasks/file.mjs';
import { resolveCycleSettings } from './work-detection.mjs';

test('run-wide settings: override over config over the opus/medium defaults', () => {
	assert.deepEqual(resolveBaseSettings({}), { model: 'opus', effort: 'medium' });
	assert.deepEqual(resolveBaseSettings({ model: 'sonnet', effort: 'high' }), { model: 'sonnet', effort: 'high' });
	assert.deepEqual(resolveBaseSettings({ model: 'sonnet' }, { effort: 'low' }), { model: 'sonnet', effort: 'low' });
	assert.throws(() => resolveBaseSettings({ effort: 'extreme' }), /Invalid effort/);
});

test('profile frontmatter carries model and effort; an unknown effort is ignored', () => {
	const profile = '---\nname: alice\nmodel: "claude-sonnet-5-5"\neffort: high\n---\nBody effort: max\n';
	assert.deepEqual(parseProfileSettings(profile), { model: 'claude-sonnet-5-5', effort: 'high' });
	assert.deepEqual(parseProfileSettings('---\nname: bob\neffort: huge\n---\n'), {});
	assert.deepEqual(parseProfileSettings('no frontmatter\neffort: max\n'), {});
});

test('cycle effort is the highest item effort, an item without one counting as the member', () => {
	assert.deepEqual(cycleEffort('medium', []), { effort: 'medium', setBy: [] });
	assert.deepEqual(cycleEffort('medium', [{ source: 'a' }, { source: 'b', effort: 'xhigh' }]), {
		effort: 'xhigh',
		setBy: ['b'],
	});
	// A lone low-effort item lowers the cycle; beside ordinary work it does not.
	assert.deepEqual(cycleEffort('high', [{ source: 'checkin', effort: 'low' }]), { effort: 'low', setBy: ['checkin'] });
	assert.deepEqual(cycleEffort('high', [{ source: 'checkin', effort: 'low' }, { source: 'todo' }]), {
		effort: 'high',
		setBy: [],
	});
});

test('the claude adapter passes model and effort through, and omits them when unset', () => {
	const { args } = createClaudeAdapter('p.md', '', { model: 'opus', effort: 'low' });
	assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'opus']);
	assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'low']);
	const bare = createClaudeAdapter('p.md', '', {}).args;
	assert.equal(bare.includes('--model') || bare.includes('--effort'), false);
});

async function withTeam(fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-effort-'));
	const members = [
		{ name: 'alice', type: 'ai' },
		{ name: 'bob', type: 'ai' },
		{ name: 'nate', type: 'human' },
	];
	await writeFile(join(dir, 'members.json'), JSON.stringify({ members }), 'utf-8');
	for (const m of members) await mkdir(join(dir, 'members', m.name), { recursive: true });
	try {
		await fn(dir, {
			messaging: new FileMessagingAdapter(dir),
			tasks: new FileTasksAdapter(dir),
			schedule: new FileScheduleAdapter(dir),
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('only a human can set effort on a message', async () => {
	await withTeam(async (_dir, { messaging }) => {
		await assert.rejects(
			messaging.sendMessage({ from: 'alice', to: ['bob'], subject: 's', body: 'b', effort: 'max' }),
			/only a human member can set effort/,
		);
		const { id } = await messaging.sendMessage({ from: 'nate', to: ['bob'], subject: 's', body: 'b', effort: 'high' });
		assert.equal((await messaging.readMessage(id)).effort, 'high');
		assert.equal((await messaging.listInbox('bob'))[0].effort, 'high');
	});
});

test('a cycle resolves profile, then the items it serves at its priority', async () => {
	await withTeam(async (dir, adapters) => {
		const base = { model: 'opus', effort: 'medium' };
		await writeFile(join(dir, 'members', 'bob', 'profile.md'), '---\nname: bob\nmodel: sonnet\neffort: low\n---\n');
		assert.deepEqual(await resolveCycleSettings('bob', 'pressing', dir, adapters, base), {
			model: 'sonnet',
			effort: 'low',
			setBy: [],
		});

		await adapters.tasks.addTodo('bob', { title: 'Audit auth', priority: 'thisWeek', effort: 'xhigh' });
		const pressing = await resolveCycleSettings('bob', 'pressing', dir, adapters, base);
		assert.equal(pressing.effort, 'low', 'a thisWeek todo is not served by a pressing cycle');
		const thisWeek = await resolveCycleSettings('bob', 'thisWeek', dir, adapters, base);
		assert.deepEqual(thisWeek, { model: 'sonnet', effort: 'xhigh', setBy: ['todo "Audit auth"'] });

		await adapters.schedule.addEvent('bob', { title: 'Retro', time: new Date(0).toISOString(), effort: 'max' });
		await adapters.messaging.sendMessage({ from: 'nate', to: ['bob'], subject: 'Look', body: 'b', effort: 'high' });
		const due = await resolveCycleSettings('bob', 'pressing', dir, adapters, base);
		assert.deepEqual(due, { model: 'sonnet', effort: 'max', setBy: ['event "Retro"'] });
	});
});

test('todos and events validate effort and clear it with null', async () => {
	await withTeam(async (_dir, { tasks, schedule }) => {
		await assert.rejects(tasks.addTodo('bob', { title: 't', priority: 'today', effort: 'lots' }), /effort must be one of/);
		const { id } = await tasks.addTodo('bob', { title: 't', priority: 'today', effort: 'high' });
		await tasks.updateTodo('bob', id, { effort: null });
		assert.equal((await tasks.listTodos('bob'))[0].effort, undefined);

		const ev = await schedule.addEvent('bob', { title: 'e', time: new Date().toISOString(), effort: 'low' });
		await assert.rejects(schedule.updateEvent('bob', ev.id, { effort: 'lots' }), /effort must be one of/);
		assert.equal((await schedule.listEvents('bob'))[0].effort, 'low');
	});
});
