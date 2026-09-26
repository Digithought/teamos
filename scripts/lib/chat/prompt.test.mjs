import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileMessagingAdapter } from '../messaging/file.mjs';
import { buildChatPrompt, buildTranscriptMessage, buildWrapUpPrompt, renderTranscript } from './prompt.mjs';

async function withTeam(fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-chat-'));
	await mkdir(join(dir, 'members', 'ada'), { recursive: true });
	await writeFile(
		join(dir, 'members.json'),
		JSON.stringify({ members: [{ name: 'ada', title: 'Engineer' }, { name: 'nate' }] }),
		'utf-8',
	);
	await writeFile(join(dir, 'org.md'), '# Acme', 'utf-8');
	await writeFile(join(dir, 'members', 'ada', 'profile.md'), '# ada\n\nWrites compilers.', 'utf-8');
	await writeFile(join(dir, 'members', 'ada', 'state.md'), 'Halfway through the parser rewrite.', 'utf-8');
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('buildChatPrompt carries the member context but not the cycle framing', async () => {
	await withTeam(async (dir) => {
		const messaging = new FileMessagingAdapter(dir);
		await messaging.sendMessage({ from: 'nate', to: ['ada'], subject: 'parser', body: 'how is it going?' });

		const prompt = await buildChatPrompt({ name: 'ada', title: 'Engineer' }, dir, { messaging }, { human: 'nate' });

		assert.match(prompt, /# TeamOS Chat: ada \(Engineer\)/);
		assert.match(prompt, /# Talking with: nate/);
		assert.match(prompt, /Writes compilers\./, 'profile is included');
		assert.match(prompt, /Halfway through the parser rewrite\./, 'state is included');
		assert.match(prompt, /how is it going\?/, 'inbox is included');
		assert.match(prompt, /## Chat Rules/);
		assert.match(prompt, /_Nothing said yet/, 'empty transcript is spelled out');

		// A chat instance has the same tools a cycle does, so it is told about
		// them in the same words.
		assert.match(prompt, /## Agent Tools/);
		assert.match(prompt, /\*\*add_todo\*\*/);

		// The things a cycle prompt has that a chat must not.
		assert.doesNotMatch(prompt, /Execute a cycle/);
		assert.doesNotMatch(prompt, /## Cycle Rules/);

		// Nothing has moved, so no staleness warning is manufactured.
		assert.doesNotMatch(prompt, /## Changed Since This Chat Opened/);
	});
});

test('buildChatPrompt names the files a concurrent cycle changed', async () => {
	await withTeam(async (dir) => {
		const messaging = new FileMessagingAdapter(dir);
		const prompt = await buildChatPrompt(
			{ name: 'ada' },
			dir,
			{ messaging },
			{
				human: 'nate',
				transcript: [{ role: 'member', text: 'the parser todo is still open', at: '2026-09-22T10:00:00.000Z' }],
				changedFiles: ['team/members/ada/state.md', 'team/members/ada/todo.json'],
			},
		);
		assert.match(prompt, /## Changed Since This Chat Opened/);
		assert.match(prompt, /`team\/members\/ada\/state\.md`/);
		assert.match(prompt, /`team\/members\/ada\/todo\.json`/);
		// The warning is about the transcript, not about the sections above it.
		assert.match(prompt, /rebuilt just now, so they are current/);
		assert.match(prompt, /Another instance of you/);
	});
});

test('buildChatPrompt replays the conversation so far', async () => {
	await withTeam(async (dir) => {
		const messaging = new FileMessagingAdapter(dir);
		const prompt = await buildChatPrompt(
			{ name: 'ada' },
			dir,
			{ messaging },
			{
				human: 'nate',
				transcript: [
					{ role: 'human', text: 'can we drop the ticket?', at: '2026-09-22T10:00:00.000Z' },
					{ role: 'member', text: 'not yet — review is pending', at: '2026-09-22T10:00:30.000Z' },
				],
			},
		);
		assert.match(prompt, /### nate — 2026-09-22T10:00:00\.000Z/);
		assert.match(prompt, /can we drop the ticket\?/);
		assert.match(prompt, /### ada — 2026-09-22T10:00:30\.000Z/);
		assert.match(prompt, /not yet — review is pending/);
	});
});

test('buildTranscriptMessage files the whole conversation from the human', () => {
	const message = buildTranscriptMessage({
		member: 'ada',
		human: 'nate',
		transcript: [
			{ role: 'human', text: 'bump the parser todo to pressing', at: '2026-09-22T10:00:00.000Z' },
			{ role: 'member', text: 'will do next cycle', at: '2026-09-22T10:00:20.000Z' },
		],
		startedAt: '2026-09-22T10:00:00.000Z',
		endedAt: '2026-09-22T10:05:00.000Z',
	});

	assert.equal(message.from, 'nate');
	assert.deepEqual(message.to, ['ada']);
	assert.equal(message.subject, 'Chat with nate — 2026-09-22 10:00');
	assert.match(message.body, /bump the parser todo to pressing/);
	assert.match(message.body, /will do next cycle/);
	assert.match(message.body, /archived record/i, 'a reader is told this is the record, not a request');
	assert.match(message.body, /wrapped up into your state and todos/i);
	assert.doesNotMatch(message.body, /no write access/i);
});

test('renderTranscript labels each turn with the speaker', () => {
	const lines = renderTranscript([{ role: 'member', text: 'hi', at: 'T' }], { human: 'nate', member: 'ada' });
	assert.deepEqual(lines, ['### ada — T', '', 'hi', '']);
});

test('buildWrapUpPrompt asks for a cycle-style wrap-up and lists leftovers only when there are some', () => {
	const plain = buildWrapUpPrompt({ human: 'nate' });
	assert.match(plain, /nate has ended the chat/);
	assert.match(plain, /state\.md/);
	assert.match(plain, /archived as a record, not sent to your inbox/);
	assert.doesNotMatch(plain, /uncommitted/);

	const withLeft = buildWrapUpPrompt({ human: 'nate', leftovers: [{ path: 'src/a.ts', status: ' M' }] });
	assert.match(withLeft, /uncommitted in the shared checkout/);
	assert.match(withLeft, / M src\/a\.ts/);
});
