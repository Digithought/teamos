import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileMessagingAdapter } from '../messaging/file.mjs';
import { buildChatPrompt, buildTranscriptMessage, renderTranscript } from './prompt.mjs';

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

		// The things a cycle prompt has that a chat must not.
		assert.doesNotMatch(prompt, /## Agent Tools/, 'a chat session is given no MCP tools to call');
		assert.doesNotMatch(prompt, /Execute a cycle/);
		assert.doesNotMatch(prompt, /## Cycle Rules/);
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
	assert.match(message.body, /nothing in it has been applied/i, 'the next cycle is told it owns the actions');
});

test('renderTranscript labels each turn with the speaker', () => {
	const lines = renderTranscript([{ role: 'member', text: 'hi', at: 'T' }], { human: 'nate', member: 'ada' });
	assert.deepEqual(lines, ['### ada — T', '', 'hi', '']);
});
