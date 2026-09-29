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
	// A second controller over the same team dir is a restarted dashboard.
	const reopen = () => new ChatSessions(options);
	const options = {
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
	};
	const chat = reopen();

	try {
		await fn({ chat, messaging, teamDir, dir, reopen });
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

/** A stub agent that writes the trailing prompt argument (the turn's task) where the test can read it. */
const TASK_STUB = `
	const fs = require('node:fs');
	fs.appendFileSync(process.env.TEAMOS_STUB_PROMPT_OUT, process.argv.at(-1) + '\\n---\\n');
	const say = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
	say({ type: 'result', is_error: false, result: 'recorded' });
`;

test('ending a chat wraps up like a cycle and archives the transcript instead of mailing it', async () => {
	await withChat(TASK_STUB, async ({ chat, messaging, dir }) => {
		const session = await chat.create({ member: 'ada', human: 'nate' });
		await chat.turn(session.id, 'raise the parser todo');

		const { persisted, messageId, wrappingUp } = await chat.end(session.id);
		assert.equal(persisted, true);
		assert.equal(wrappingUp, true);

		// Not in the inbox — the next cycle must not be woken to re-read its own conversation.
		assert.equal((await messaging.listInbox('ada')).length, 0);
		const archived = await messaging.listArchives('ada');
		assert.deepEqual(archived.map((m) => m.id), [messageId]);
		const message = await messaging.readMessage(messageId);
		assert.match(message.body, /raise the parser todo/);
		assert.match(message.body, /archived record/);

		await chat.settled();
		const tasks = (await readFile(join(dir, 'prompt.txt'), 'utf-8')).split('\n---\n');
		const wrap = tasks.at(-2);
		assert.match(wrap, /nate has ended the chat\. Wrap up/);
		assert.match(wrap, /state\.md/);
		assert.doesNotMatch(wrap, /uncommitted/, 'no leftovers section when the chat changed nothing');
	});
});

test('an empty chat does nothing; a discarded chat records nothing and runs no wrap-up without leftovers', async () => {
	await withChat(TASK_STUB, async ({ chat, messaging, dir }) => {
		const empty = await chat.create({ member: 'ada', human: 'nate' });
		assert.deepEqual(await chat.end(empty.id), { persisted: false, wrappingUp: false });
		assert.throws(() => chat.get(empty.id), (err) => err.status === 410 && err.gone.reason === 'ended');

		const discarded = await chat.create({ member: 'ada', human: 'nate' });
		await chat.turn(discarded.id, 'never mind');
		assert.deepEqual(await chat.end(discarded.id, { persist: false }), { persisted: false, wrappingUp: true });
		await chat.settled();

		assert.equal((await messaging.listInbox('ada')).length, 0);
		assert.equal((await messaging.listArchives('ada')).length, 0);
		// Only the one real turn reached the agent; the discard found nothing to clean up.
		const tasks = (await readFile(join(dir, 'prompt.txt'), 'utf-8')).split('\n---\n').filter(Boolean);
		assert.equal(tasks.length, 1);
	});
});

test('an abandoned session is swept and filed', async () => {
	await withChat(null, async ({ chat, messaging }) => {
		const session = await chat.create({ member: 'ada', human: 'nate' });
		session.transcript.push({ role: 'human', text: 'walked away mid-chat', at: new Date().toISOString() });
		session.lastActiveAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		session.lastSeenMs = Date.now() - 11 * 60 * 1000; // no tab has polled it: closed

		const status = await chat.status('ada');
		assert.equal(status.session, null, 'the stale session is gone');
		assert.equal((await messaging.listArchives('ada')).length, 1, 'and its transcript was filed, not dropped');
		await chat.settled(); // its wrap-up has no agent to run here; it must fail quietly
	});
});

test('an open tab keeps a quiet chat alive; the sweep ends only what nobody is watching', async () => {
	await withChat(null, async ({ chat }) => {
		const session = await chat.create({ member: 'ada', human: 'nate' });
		session.transcript.push({ role: 'human', text: 'let me think', at: new Date().toISOString() });
		// An hour since the last turn, and the pane's poll has only just missed its window.
		session.lastActiveAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		session.lastSeenMs = Date.now() - 11 * 60 * 1000;

		// The poll from the open tab is the heartbeat, and it lands before the sweep.
		const watched = await chat.status('ada', { sessionId: session.id });
		assert.equal(watched.session?.id, session.id, 'a watched chat survives an hour without a turn');
		assert.equal(watched.gone, null);

		// Forgotten in an open tab: the second clock ends it anyway.
		session.lastActiveAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
		const quiet = await chat.status('ada', { sessionId: session.id });
		assert.equal(quiet.session, null);
		assert.equal(quiet.gone.reason, 'idle');
		assert.deepEqual(quiet.gone.idle, { kind: 'quiet', minutes: 300 });
		await chat.settled();
	});
});

test('a gone session says what happened to it', async () => {
	await withChat(TASK_STUB, async ({ chat }) => {
		const session = await chat.create({ member: 'ada', human: 'nate' });
		await chat.turn(session.id, 'raise the parser todo');
		session.lastSeenMs = Date.now() - 45 * 60 * 1000;
		session.lastActiveAt = new Date(Date.now() - 45 * 60 * 1000).toISOString();
		await chat.sweepIdle();

		await assert.rejects(
			() => chat.turn(session.id, 'still there?'),
			(err) => {
				assert.equal(err.status, 410);
				assert.equal(err.gone.reason, 'idle');
				assert.deepEqual(err.gone.idle, { kind: 'unwatched', minutes: 45 });
				assert.equal(err.gone.member, 'ada');
				assert.match(err.gone.messageId, /\S/, 'names the archived transcript');
				assert.equal(err.gone.turns, 2);
				assert.equal(err.gone.transcript, undefined, 'the record, not the conversation');
				return true;
			},
		);
		await chat.settled();
		assert.equal(chat.gone(session.id).wrapUp, 'done');

		const status = await chat.status('ada', { sessionId: session.id });
		assert.equal(status.gone.reason, 'idle');

		// An id the dashboard never saw — lost in a restart before sessions were kept.
		await assert.rejects(
			() => chat.turn('2020-01-01T00-00-00.000Z-abcd', 'hi'),
			(err) => err.status === 404 && err.gone.reason === 'unknown',
		);

		const discarded = await chat.create({ member: 'ada', human: 'nate' });
		await chat.end(discarded.id, { persist: false });
		assert.equal(chat.gone(discarded.id).reason, 'discarded');
	});
});

test('continuing an ended chat carries the conversation and records only what is new', async () => {
	const stub = `
		const fs = require('node:fs');
		const promptFile = process.argv[process.argv.indexOf('--append-system-prompt-file') + 1];
		fs.appendFileSync(process.env.TEAMOS_STUB_PROMPT_OUT, fs.readFileSync(promptFile, 'utf-8') + '\\n<<TASK>>\\n' + process.argv.at(-1) + '\\n=====\\n');
		process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'noted' }) + '\\n');
	`;
	await withChat(stub, async ({ chat, messaging, dir }) => {
		const first = await chat.create({ member: 'ada', human: 'nate' });
		await chat.turn(first.id, 'ship the parser friday');
		const { messageId: firstMessage } = await chat.end(first.id);
		await chat.settled();

		const next = await chat.create({ member: 'ada', human: 'nate', continueFrom: first.id });
		assert.deepEqual(
			next.transcript.map((t) => t.text),
			['ship the parser friday', 'noted'],
			'the earlier conversation is seeded from the record',
		);
		assert.equal(next.breaks.length, 1);
		assert.equal(next.breaks[0].index, 2);
		assert.equal(next.breaks[0].wrappedUp, true);
		assert.equal(next.continues.messageId, firstMessage);

		await chat.turn(next.id, 'and the lexer monday');
		const runs = () => readFile(join(dir, 'prompt.txt'), 'utf-8').then((t) => t.split('\n=====\n').filter(Boolean));
		const turnPrompt = (await runs()).at(-1);
		assert.match(turnPrompt, /ship the parser friday/, 'the member sees the earlier conversation');
		assert.match(turnPrompt, /was wrapped up into your state and todos/, 'and where it was wrapped up');

		const { messageId } = await chat.end(next.id);
		await chat.settled();
		const wrap = (await runs()).at(-1).split('<<TASK>>')[1];
		assert.match(wrap, /continued one you already wrapped up/);
		assert.match(wrap, /record only what was said after it/);

		const message = await messaging.readMessage(messageId);
		assert.equal(message.replyTo, firstMessage, 'threads onto the earlier record');
		assert.match(message.body, /and the lexer monday/);
		assert.doesNotMatch(message.body, /ship the parser friday/, 'the earlier part is not archived twice');

		// A continuation nobody spoke in has nothing new: no wrap-up, no archive.
		const before = (await runs()).length;
		const idle = await chat.create({ member: 'ada', human: 'nate', continueFrom: next.id });
		assert.deepEqual(await chat.end(idle.id), { persisted: false, wrappingUp: false });
		await chat.settled();
		assert.equal((await runs()).length, before);
		assert.equal((await messaging.listArchives('ada')).length, 2);
	});
});

test('continuing a chat the dashboard lost uses the transcript the browser kept', async () => {
	await withChat(TASK_STUB, async ({ chat, dir }) => {
		const transcript = [
			{ role: 'human', text: 'what about the parser?', at: '2026-01-01T10:00:00.000Z' },
			{ role: 'member', text: 'friday', at: '2026-01-01T10:00:05.000Z' },
		];
		const junk = await chat.create({ member: 'ada', human: 'nate', continueFrom: 'lost', transcript: [{ role: 'root' }] });
		assert.equal(junk.transcript.length, 0, 'a malformed transcript seeds nothing');
		await chat.end(junk.id);

		const session = await chat.create({ member: 'ada', human: 'nate', continueFrom: 'lost', transcript });
		assert.deepEqual(session.transcript, transcript);
		assert.equal(session.breaks[0].wrappedUp, false, 'never wrapped up, so the continuation records all of it');

		await chat.turn(session.id, 'and the lexer?');
		await chat.end(session.id);
		await chat.settled();
		const wrap = (await readFile(join(dir, 'prompt.txt'), 'utf-8')).split('\n---\n').filter(Boolean).at(-1);
		assert.doesNotMatch(wrap, /continued one you already wrapped up/);

		// Another member's record can't be borrowed.
		const ended = await chat.create({ member: 'ada', human: 'nate' });
		await chat.end(ended.id);
		await assert.rejects(
			() => chat.create({ member: 'nate', human: 'nate', continueFrom: ended.id }),
			(err) => err.status === 400,
		);
	});
});

test('a restarted dashboard restores open chats and remembers ended ones, without re-running a wrap-up', async () => {
	await withChat(TASK_STUB, async ({ chat, reopen, dir, teamDir }) => {
		const open = await chat.create({ member: 'ada', human: 'nate' });
		await chat.turn(open.id, 'keep this');
		const ended = await chat.create({ member: 'nate', human: 'nate' });
		await chat.turn(ended.id, 'and file this');
		await chat.end(ended.id);
		await chat.settled();
		const runs = async () => (await readFile(join(dir, 'prompt.txt'), 'utf-8')).split('\n---\n').filter(Boolean).length;
		const before = await runs();

		const restarted = reopen();
		const status = await restarted.status('ada', { sessionId: open.id });
		assert.equal(status.session?.id, open.id, 'the open chat is back under its own id');
		assert.deepEqual(
			status.session.transcript.map((t) => t.text),
			['keep this', 'recorded'],
		);
		assert.equal(status.session.busy, false);
		await restarted.turn(open.id, 'still here');
		assert.equal(restarted.get(open.id).transcript.length, 4);

		assert.throws(() => restarted.get(ended.id), (err) => err.status === 410 && err.gone.wrapUp === 'done');
		const continued = await restarted.create({ member: 'nate', human: 'nate', continueFrom: ended.id });
		assert.equal(continued.breaks[0].wrappedUp, true, 'the record survives the restart');
		await restarted.settled();
		assert.equal(await runs(), before + 1, 'only the new turn ran — no wrap-up was started again');

		// A wrap-up the dead process was still running is reported as cut off, and not re-run.
		const file = join(teamDir, '.logs', 'chat', 'sessions', `${ended.id}.json`);
		const saved = JSON.parse(await readFile(file, 'utf-8'));
		await writeFile(file, JSON.stringify({ ...saved, wrapUp: 'running' }), 'utf-8');
		const cut = reopen();
		assert.equal((await cut.status('nate', { sessionId: ended.id })).gone.wrapUp, 'interrupted');
		await cut.settled();
		assert.equal(await runs(), before + 1);

		// A torn file is skipped, not fatal.
		await writeFile(join(teamDir, '.logs', 'chat', 'sessions', 'junk.json'), '{', 'utf-8');
		const again = reopen();
		await again.ready();
		assert.ok(again.sessions.has(open.id));
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
