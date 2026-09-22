import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileMessagingAdapter } from '../messaging/file.mjs';
import { ChatSessions, changedFilesSince, detectMidCycle, readCycleExit, resolveChatConfig } from './session.mjs';

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
		config: {
			chat: {
				env: {
					PATH: stubScript ? `${bin}:${process.env.PATH}` : bin,
					// Lets a stub dump the prompt it was handed, which is the only
					// way to assert on what a turn actually told the member.
					TEAMOS_STUB_PROMPT_OUT: join(dir, 'prompt.txt'),
					TEAMOS_STUB_GO: join(dir, 'go'),
				},
			},
		},
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
		assert.equal(status.midCycle, true, 'chat runs beside the cycle; the flag is informational');
		assert.equal(status.session.id, session.id);
		assert.equal(status.session.busy, false);
		assert.deepEqual(status.changedFiles, [], 'nothing has moved since the chat opened');
	});
});

test('readCycleExit finds the runner marker, and only the runner marker', async () => {
	await withChat(null, async ({ dir }) => {
		const log = join(dir, 'cycle.log');
		await writeFile(log, 'Member: ada\nsome output\n', 'utf-8');
		assert.equal(await readCycleExit(log), null, 'a cycle still running has no marker');

		await writeFile(log, 'Member: ada\n\n[runner] Agent exited with code 0\n', 'utf-8');
		assert.equal(await readCycleExit(log), 0);

		// Logs are appended to across reruns; the last marker is the live one.
		await writeFile(
			log,
			'[runner] Agent exited with code 0\nmore\n[runner] Agent exited with code 3\n',
			'utf-8',
		);
		assert.equal(await readCycleExit(log), 3);

		assert.equal(await readCycleExit(join(dir, 'nope.log')), null);
	});
});

test('changedFilesSince reports the member files a cycle rewrote', async () => {
	await withChat(null, async ({ teamDir }) => {
		const memberDir = join(teamDir, 'members', 'ada');
		const cutoff = Date.now();
		// profile.md was written a moment ago, within the same millisecond tick
		// as the cutoff; age it so "before" really is before.
		const earlier = cutoff / 1000 - 60;
		await utimes(join(memberDir, 'profile.md'), earlier, earlier);
		assert.deepEqual(await changedFilesSince(teamDir, 'ada', cutoff), [], 'profile.md predates the cutoff');

		// mtime is the signal, so move it rather than racing the clock.
		await writeFile(join(memberDir, 'state.md'), 'parser landed', 'utf-8');
		const later = cutoff / 1000 + 60;
		await utimes(join(memberDir, 'state.md'), later, later);

		assert.deepEqual(await changedFilesSince(teamDir, 'ada', cutoff), ['team/members/ada/state.md']);
		assert.deepEqual(await changedFilesSince(teamDir, 'ghost', cutoff), [], 'an unknown member is empty, not an error');
	});
});

/** Stand a finished cycle up on disk: prompt file gone, exit marker in the log. */
async function finishCycle(teamDir, stem, { marker = true } = {}) {
	const logs = join(teamDir, '.logs');
	await mkdir(logs, { recursive: true });
	await writeFile(join(logs, `${stem}.log`), marker ? '\n[runner] Agent exited with code 0\n' : 'killed\n', 'utf-8');
	await rm(join(logs, `${stem}.prompt.md`), { force: true });
}

test('a cycle finishing mid-chat is recorded, once, and only with the exit marker', async () => {
	await withChat(null, async ({ chat, teamDir }) => {
		const logs = join(teamDir, '.logs');
		await mkdir(logs, { recursive: true });
		await writeFile(join(logs, 'ada.today.1.prompt.md'), 'x', 'utf-8');

		// The chat opens beside a cycle already in flight — no 409, no waiting.
		const session = await chat.create({ member: 'ada', human: 'nate' });
		assert.equal(session.cycleCompletions.length, 0);

		await chat.pollCycles();
		assert.equal(session.cycleCompletions.length, 0, 'still running');

		await finishCycle(teamDir, 'ada.today.1');
		await chat.pollCycles();
		assert.equal(session.cycleCompletions.length, 1);
		assert.equal(session.cycleCompletions[0].exitCode, 0);

		await chat.pollCycles();
		assert.equal(session.cycleCompletions.length, 1, 'a completion fires once, not on every poll');

		// A prompt file removed without the runner ever finishing (killed
		// runner, log sweep) is not a completion.
		await writeFile(join(logs, 'ada.today.2.prompt.md'), 'x', 'utf-8');
		await chat.pollCycles();
		await finishCycle(teamDir, 'ada.today.2', { marker: false });
		await chat.pollCycles();
		assert.equal(session.cycleCompletions.length, 1);

		// And the status the pane polls carries it.
		const status = await chat.status('ada');
		assert.equal(status.session.cycleCompletions.length, 1);
	});
});

test('a cycle finishing during a turn is pushed onto that turn stream', async () => {
	// Holds the turn open until the test has staged the cycle completion.
	const stub = `
		const { existsSync, writeFileSync } = require('node:fs');
		const promptFile = process.argv[process.argv.indexOf('--append-system-prompt-file') + 1];
		writeFileSync(process.env.TEAMOS_STUB_PROMPT_OUT, require('node:fs').readFileSync(promptFile, 'utf-8'));
		const tick = setInterval(() => {
			if (!existsSync(process.env.TEAMOS_STUB_GO)) return;
			clearInterval(tick);
			process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) + '\\n');
		}, 20);
	`;
	await withChat(stub, async ({ chat, teamDir, dir }) => {
		const logs = join(teamDir, '.logs');
		await mkdir(logs, { recursive: true });
		await writeFile(join(logs, 'ada.today.3.prompt.md'), 'x', 'utf-8');
		const session = await chat.create({ member: 'ada', human: 'nate' });

		const events = [];
		const turn = chat.turn(session.id, 'busy?', { onEvent: (event) => events.push(event) });

		// Wait for the turn to be in flight, then finish the cycle under it.
		for (let i = 0; i < 200 && !session.busy; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(session.busy, true, 'turn is running');
		await finishCycle(teamDir, 'ada.today.3');
		await chat.pollCycles();
		await writeFile(join(dir, 'go'), '', 'utf-8');
		await turn;

		const cycle = events.find((e) => e.kind === 'cycle');
		assert.ok(cycle, 'the open chat is told its member just finished a cycle');
		assert.equal(cycle.event, 'completed');
		assert.equal(cycle.exitCode, 0);
		assert.ok(cycle.at, 'stamped so the pane can show when');
	});
});

test("the next turn's prompt names what changed since the chat opened", async () => {
	const stub = `
		const { readFileSync, writeFileSync } = require('node:fs');
		const promptFile = process.argv[process.argv.indexOf('--append-system-prompt-file') + 1];
		writeFileSync(process.env.TEAMOS_STUB_PROMPT_OUT, readFileSync(promptFile, 'utf-8'));
		process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'rechecked' }) + '\\n');
	`;
	await withChat(stub, async ({ chat, teamDir, dir }) => {
		// The fixture's files were written in this same millisecond; age them so
		// the baseline is genuinely "before the chat opened".
		const memberDir = join(teamDir, 'members', 'ada');
		const earlier = Date.now() / 1000 - 60;
		await utimes(join(memberDir, 'profile.md'), earlier, earlier);
		const session = await chat.create({ member: 'ada', human: 'nate' });

		await chat.turn(session.id, 'first', {});
		assert.doesNotMatch(
			await readFile(join(dir, 'prompt.txt'), 'utf-8'),
			/## Changed Since This Chat Opened/,
			'nothing has moved yet',
		);

		// A cycle rewrites state.md underneath the conversation.
		const stateFile = join(teamDir, 'members', 'ada', 'state.md');
		await writeFile(stateFile, 'parser landed', 'utf-8');
		const later = Date.now() / 1000 + 60;
		await utimes(stateFile, later, later);

		await chat.turn(session.id, 'second', {});
		const prompt = await readFile(join(dir, 'prompt.txt'), 'utf-8');
		assert.match(prompt, /## Changed Since This Chat Opened/);
		assert.match(prompt, /team\/members\/ada\/state\.md/);
		assert.match(prompt, /Re-read before you repeat an earlier answer/);
	});
});
