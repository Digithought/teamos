import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileMessagingAdapter } from '../messaging/file.mjs';
import { ChatSessions, detectMidCycle, resolveChatConfig } from './session.mjs';

/**
 * A team workspace plus a stub `claude` on PATH. Chat spawns the agent through
 * the same `runAgent` the runner uses, so the stub is the only way to exercise
 * a turn without a live Claude session; `chat.env` is the hook that puts it on
 * PATH, which is the same mechanism that points chat at a second account.
 */
async function withChat(stubScript, fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-chatsess-'));
	const teamDir = join(dir, 'team');
	await mkdir(join(teamDir, 'members', 'ada'), { recursive: true });
	await writeFile(
		join(teamDir, 'members.json'),
		JSON.stringify({ members: [{ name: 'ada', title: 'Engineer' }, { name: 'nate' }] }),
		'utf-8',
	);
	await writeFile(join(teamDir, 'members', 'ada', 'profile.md'), '# ada', 'utf-8');

	// PATH is the stub's bin dir alone when there is no stub, so a test that
	// means "the agent binary is missing" can't find the real `claude`.
	const bin = join(dir, 'bin');
	await mkdir(bin, { recursive: true });
	if (stubScript) {
		const stub = join(bin, 'claude');
		await writeFile(stub, `#!/usr/bin/env node\n${stubScript}\n`, 'utf-8');
		await chmod(stub, 0o755);
	}

	const messaging = new FileMessagingAdapter(teamDir);
	const chat = new ChatSessions({
		teamDir,
		repoRoot: dir,
		adapters: { messaging },
		config: { chat: { env: { PATH: stubScript ? `${bin}:${process.env.PATH}` : bin } } },
	});

	try {
		await fn({ chat, messaging, teamDir, dir });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('resolveChatConfig defaults to the runner agent and drops unresolved env refs', () => {
	assert.deepEqual(resolveChatConfig({ agent: 'claude' }), { agent: 'claude', env: {} });
	assert.deepEqual(resolveChatConfig({}), { agent: 'claude', env: {} });

	const resolved = resolveChatConfig({
		agent: 'claude',
		chat: { agent: 'cursor', env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-123', ANTHROPIC_API_KEY: '$MISSING_VAR' } },
	});
	assert.equal(resolved.agent, 'cursor', 'the chat account can use a different agent');
	assert.deepEqual(resolved.env, { CLAUDE_CODE_OAUTH_TOKEN: 'tok-123' }, 'an unset $VAR is not exported literally');
});

test('detectMidCycle reads the runner prompt file, ignoring stale and foreign ones', async () => {
	await withChat(null, async ({ teamDir }) => {
		assert.deepEqual(await detectMidCycle(teamDir, 'ada'), { midCycle: false }, 'no logs dir yet');

		const logs = join(teamDir, '.logs');
		await mkdir(logs, { recursive: true });
		await writeFile(join(logs, 'bob.today.2026-01-01.prompt.md'), 'x', 'utf-8');
		assert.deepEqual(await detectMidCycle(teamDir, 'ada'), { midCycle: false }, "another member's cycle");

		await writeFile(join(logs, 'ada.pressing.2026-01-01.prompt.md'), 'x', 'utf-8');
		const live = await detectMidCycle(teamDir, 'ada');
		assert.equal(live.midCycle, true);
		assert.ok(live.since, 'reports when the cycle started');

		// A prompt file the runner never got to unlink ages out rather than
		// pinning the badge on forever.
		const stale = join(logs, 'ada.today.2020-01-01.prompt.md');
		await writeFile(stale, 'x', 'utf-8');
		await rm(join(logs, 'ada.pressing.2026-01-01.prompt.md'));
		const old = Date.now() / 1000 - 3 * 60 * 60;
		const { utimes } = await import('node:fs/promises');
		await utimes(stale, old, old);
		assert.deepEqual(await detectMidCycle(teamDir, 'ada'), { midCycle: false });
	});
});

test('create rejects an unknown member, a missing human, and a second chat', async () => {
	await withChat(null, async ({ chat }) => {
		await assert.rejects(() => chat.create({ member: 'ghost', human: 'nate' }), (err) => err.status === 404);
		await assert.rejects(() => chat.create({ member: 'ada', human: '' }), (err) => err.status === 400);

		const session = await chat.create({ member: 'ada', human: 'nate' });
		assert.equal(session.member, 'ada');

		await assert.rejects(
			() => chat.create({ member: 'ada', human: 'nate' }),
			(err) => err.status === 409 && /already open/.test(err.message),
		);

		// Ending the first one frees the member.
		await chat.end(session.id);
		const second = await chat.create({ member: 'ada', human: 'nate' });
		assert.notEqual(second.id, session.id);
	});
});

test('turn rejects unknown sessions and empty text', async () => {
	await withChat(null, async ({ chat }) => {
		await assert.rejects(() => chat.turn('nope', 'hi'), (err) => err.status === 404);
		const session = await chat.create({ member: 'ada', human: 'nate' });
		await assert.rejects(() => chat.turn(session.id, '   '), (err) => err.status === 400);
	});
});

test('a turn streams the member reply and keeps it in the transcript', async () => {
	const stub = `
		const say = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
		say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file: 'state.md' } }] } });
		say({ type: 'assistant', message: { content: [{ type: 'text', text: 'the parser lands tomorrow' }] } });
		say({ type: 'result', is_error: false, result: 'the parser lands tomorrow' });
	`;
	await withChat(stub, async ({ chat, teamDir }) => {
		const session = await chat.create({ member: 'ada', human: 'nate' });
		const events = [];
		const { exitCode, answer } = await chat.turn(session.id, 'when does the parser land?', {
			onEvent: (event) => events.push(event),
		});

		assert.equal(exitCode, 0);
		assert.equal(answer, 'the parser lands tomorrow');
		assert.deepEqual(
			events.map((e) => e.kind),
			['tool', 'text', 'result'],
		);
		assert.deepEqual(
			session.transcript.map((t) => [t.role, t.text]),
			[
				['human', 'when does the parser land?'],
				['member', 'the parser lands tomorrow'],
			],
		);

		// Chat logs live under .logs/chat/ so they can never be mistaken for a
		// cycle in flight by detectMidCycle.
		assert.deepEqual(await detectMidCycle(teamDir, 'ada'), { midCycle: false });
	});
});

test('a failed turn still records what the human said', async () => {
	const stub = `process.stderr.write('boom\\n'); process.exit(3);`;
	await withChat(stub, async ({ chat }) => {
		const session = await chat.create({ member: 'ada', human: 'nate' });
		const { exitCode, answer } = await chat.turn(session.id, 'are you there?');
		assert.equal(exitCode, 3);
		assert.equal(answer, '');
		assert.deepEqual(
			session.transcript.map((t) => t.role),
			['human'],
		);
	});
});

test('a spawn failure surfaces as an error, not a silent empty reply', async () => {
	// No stub on PATH: `claude` cannot be spawned at all.
	await withChat(null, async ({ chat }) => {
		const session = await chat.create({ member: 'ada', human: 'nate' });
		await assert.rejects(() => chat.turn(session.id, 'hello'), /ENOENT|spawn/);
		// The session survives a failed turn and is not left marked busy.
		assert.equal(chat.get(session.id).busy, false);
	});
});

test('ending a chat files the transcript to the member inbox', async () => {
	await withChat(null, async ({ chat, messaging }) => {
		const session = await chat.create({ member: 'ada', human: 'nate' });
		session.transcript.push({ role: 'human', text: 'raise the parser todo', at: new Date().toISOString() });
		session.transcript.push({ role: 'member', text: 'noted for next cycle', at: new Date().toISOString() });

		const { persisted, messageId } = await chat.end(session.id);
		assert.equal(persisted, true);

		const inbox = await messaging.listInbox('ada');
		assert.equal(inbox.length, 1);
		assert.equal(inbox[0].id, messageId);
		assert.equal(inbox[0].from, 'nate');

		const message = await messaging.readMessage(messageId);
		assert.match(message.body, /raise the parser todo/);
		assert.match(message.body, /noted for next cycle/);

		// The sender sees it too — it is an ordinary message, not a side channel.
		assert.equal((await messaging.listSent('nate')).length, 1);
	});
});

test('an empty chat and a discarded chat write nothing', async () => {
	await withChat(null, async ({ chat, messaging }) => {
		const empty = await chat.create({ member: 'ada', human: 'nate' });
		assert.deepEqual(await chat.end(empty.id), { persisted: false });

		const discarded = await chat.create({ member: 'ada', human: 'nate' });
		discarded.transcript.push({ role: 'human', text: 'never mind', at: new Date().toISOString() });
		assert.deepEqual(await chat.end(discarded.id, { persist: false }), { persisted: false });

		assert.equal((await messaging.listInbox('ada')).length, 0);
		assert.throws(() => chat.get(empty.id), (err) => err.status === 404);
	});
});

test('an abandoned session is swept and filed', async () => {
	await withChat(null, async ({ chat, messaging }) => {
		const session = await chat.create({ member: 'ada', human: 'nate' });
		session.transcript.push({ role: 'human', text: 'walked away mid-chat', at: new Date().toISOString() });
		session.lastActiveAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

		const status = await chat.status('ada');
		assert.equal(status.session, null, 'the stale session is gone');
		assert.equal((await messaging.listInbox('ada')).length, 1, 'and its transcript was filed, not dropped');
	});
});

test('status reports the open session and the cycle indicator together', async () => {
	await withChat(null, async ({ chat, teamDir }) => {
		const logs = join(teamDir, '.logs');
		await mkdir(logs, { recursive: true });
		await writeFile(join(logs, 'ada.today.now.prompt.md'), 'x', 'utf-8');

		const session = await chat.create({ member: 'ada', human: 'nate' });
		const status = await chat.status('ada');
		assert.equal(status.midCycle, true, 'chat does not wait for the cycle, it just says so');
		assert.equal(status.session.id, session.id);
		assert.equal(status.session.busy, false);
	});
});
