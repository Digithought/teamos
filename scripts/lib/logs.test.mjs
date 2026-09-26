import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogReader, logStatus, parseLogName, resolveLogFile, STALE_RUN_MS, summarizeLog } from './logs.mjs';

const HEADER = [
	'Member: Devin (VP of Software Engineering)',
	'Priority: pressing',
	'Agent: claude',
	'TeamOS: f710554',
	'Started: 2026-09-25T16:02:56.134Z',
	'═'.repeat(72),
	'',
].join('\n');

const FINISHED = `${HEADER}[session abc]
....
[ASSISTANT]
Looking at the inbox.

[TOOL:Bash] {"command":"ls"}
  > a.txt

[RESULT DONE | 120.5s | cost $1.2500]
Done.

[runner] Agent exited with code 0
`;

function team() {
	const dir = mkdtempSync(join(tmpdir(), 'logs-'));
	mkdirSync(join(dir, '.logs', 'chat'), { recursive: true });
	return dir;
}

test('parses cycle and chat log names, and nothing else', () => {
	assert.deepEqual(parseLogName('Devin', 'Devin.pressing.2026-09-25T16-02-56-134Z.log'), {
		kind: 'cycle',
		priority: 'pressing',
		startedAt: '2026-09-25T16:02:56.134Z',
	});
	assert.deepEqual(parseLogName('Devin', 'Devin.2026-09-25T16-02-56.134Z-k3x9.log', 'chat'), {
		kind: 'chat',
		priority: null,
		startedAt: '2026-09-25T16:02:56.134Z',
	});
	for (const bad of [
		'Devin.pressing.2026-09-25T16-02-56-134Z.prompt.md',
		'Devon.pressing.2026-09-25T16-02-56-134Z.log',
		'DevinX.pressing.2026-09-25T16-02-56-134Z.log',
		'clerk.maintenance.2026-09-25T16-02-56-134Z.log',
		'Devin.pressing.2026-09-25T16-02-56-134Z.log/x',
		'../Devin.pressing.2026-09-25T16-02-56-134Z.log',
		'Devin.../../etc/passwd.log',
		'Devin.pressing.log',
	]) {
		assert.equal(parseLogName('Devin', bad), null, bad);
	}
	assert.equal(parseLogName('Devin', 'Devin.a/b.log', 'chat'), null);
	assert.equal(parseLogName('Devin', 'Devin...log', 'chat'), null);
	assert.equal(parseLogName('../x', '../x.pressing.2026-09-25T16-02-56-134Z.log'), null);
});

test('summarizes exit code, time and cost, summing resumed runs', () => {
	assert.deepEqual(summarizeLog(FINISHED), {
		exitCode: 0,
		runs: 1,
		results: 1,
		resultErrors: 0,
		durationSec: 120.5,
		costUsd: 1.25,
		headerStartedAt: '2026-09-25T16:02:56.134Z',
	});
	const resumed = `${FINISHED}\n[RESULT ERROR | 10.0s | cost $0.5000]\nno\n\n[runner] Agent exited with code 1\n`;
	const s = summarizeLog(resumed);
	assert.equal(s.exitCode, 1);
	assert.equal(s.runs, 2);
	assert.equal(s.resultErrors, 1);
	assert.equal(s.durationSec, 130.5);
	assert.equal(s.costUsd, 1.75);
	// Text that merely mentions the markers mid-line does not count.
	const quoted = summarizeLog(`${HEADER}  > grep "[runner] Agent exited with code 3"\n`);
	assert.equal(quoted.exitCode, null);
	assert.equal(quoted.costUsd, null);
});

test('status reads running, then the exit code', () => {
	assert.equal(logStatus({ running: true, exitCode: null }), 'running');
	assert.equal(logStatus({ running: false, exitCode: null }), 'interrupted');
	assert.equal(logStatus({ running: false, exitCode: 0 }), 'ok');
	assert.equal(logStatus({ running: false, exitCode: 2 }), 'failed');
});

test('lists a member’s cycles and chats newest first, marking the live one', async () => {
	const dir = team();
	try {
		const logs = join(dir, '.logs');
		writeFileSync(join(logs, 'Devin.pressing.2026-09-25T16-02-56-134Z.log'), FINISHED);
		writeFileSync(join(logs, 'Devin.today.2026-09-25T18-00-00-000Z.log'), `${HEADER}[session x]\n...`);
		writeFileSync(join(logs, 'Devin.today.2026-09-25T18-00-00-000Z.prompt.md'), 'prompt');
		// Left behind by a killed runner: prompt file present, log long silent.
		writeFileSync(join(logs, 'Devin.later.2026-09-20T00-00-00-000Z.log'), `${HEADER}[session y]\n`);
		writeFileSync(join(logs, 'Devin.later.2026-09-20T00-00-00-000Z.prompt.md'), 'prompt');
		const old = (Date.now() - STALE_RUN_MS - 60_000) / 1000;
		utimesSync(join(logs, 'Devin.later.2026-09-20T00-00-00-000Z.log'), old, old);
		writeFileSync(join(logs, 'chat', 'Devin.2026-09-25T17-00-00.000Z-ab12.log'), '[RESULT DONE | 5.0s | cost $0.1000]\n\n[runner] Agent exited with code 0\n[RESULT DONE | 6.0s | cost $0.2000]\n\n[runner] Agent exited with code 0\n');
		writeFileSync(join(logs, 'Clay.pressing.2026-09-25T19-00-00-000Z.log'), FINISHED);
		writeFileSync(join(logs, 'clerk.maintenance.2026-09-25T19-00-00-000Z.log'), FINISHED);
		writeFileSync(join(logs, 'scheduler-state.json'), '{}');
		symlinkSync('/etc/passwd', join(logs, 'Devin.pressing.2026-09-25T20-00-00-000Z.log'));

		const reader = createLogReader(dir);
		const list = await reader.list('Devin');
		assert.deepEqual(
			list.map((l) => [l.name, l.kind, l.priority, l.status]),
			[
				['Devin.today.2026-09-25T18-00-00-000Z.log', 'cycle', 'today', 'running'],
				['Devin.2026-09-25T17-00-00.000Z-ab12.log', 'chat', null, 'ok'],
				['Devin.pressing.2026-09-25T16-02-56-134Z.log', 'cycle', 'pressing', 'ok'],
				['Devin.later.2026-09-20T00-00-00-000Z.log', 'cycle', 'later', 'interrupted'],
			],
		);
		const done = list[2];
		assert.equal(done.costUsd, 1.25);
		assert.equal(done.durationSec, 120.5);
		assert.equal(done.exitCode, 0);
		assert.equal(done.running, false);
		assert.equal(done.size, Buffer.byteLength(FINISHED));
		assert.equal(list[1].costUsd, 0.3);
		assert.equal(list[1].durationSec, 11);
		assert.deepEqual(await reader.list('Nobody'), []);
		await assert.rejects(reader.list('../etc'), { status: 400 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('refuses names that could leave .logs, and links inside it', async () => {
	const dir = team();
	try {
		writeFileSync(join(dir, 'secret.log'), 'x');
		symlinkSync(join(dir, 'secret.log'), join(dir, '.logs', 'Devin.pressing.2026-09-25T20-00-00-000Z.log'));
		for (const [member, name] of [
			['Devin', '../secret.log'],
			['Devin', '..%2Fsecret.log'],
			['Devin', 'Devin.pressing.2026-09-25T16-02-56-134Z.prompt.md'],
			['Devin', 'Devin.x/../../secret.log'],
			['Devin', ''],
			['..', '...log'],
			['Devin/..', 'Devin/...log'],
			['', 'x.log'],
		]) {
			await assert.rejects(resolveLogFile(dir, member, name), { status: 400 }, `${member} ${name}`);
		}
		await assert.rejects(resolveLogFile(dir, 'Devin', 'Devin.pressing.2026-09-25T20-00-00-000Z.log'), { status: 404 });
		await assert.rejects(resolveLogFile(dir, 'Devin', 'Devin.pressing.2026-09-25T21-00-00-000Z.log'), { status: 404 });
		const reader = createLogReader(dir);
		await assert.rejects(reader.read('Devin', '../secret.log'), { status: 400 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('reads the tail on a line boundary, earlier chunks, and appended text', async () => {
	const dir = team();
	try {
		const file = 'Devin.pressing.2026-09-25T16-02-56-134Z.log';
		const path = join(dir, '.logs', file);
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ✓`);
		const body = `${lines.join('\n')}\n`;
		writeFileSync(path, body);
		const size = Buffer.byteLength(body);
		const reader = createLogReader(dir);

		const tail = await reader.read('Devin', file, { tail: 50 });
		assert.equal(tail.to, size);
		assert.ok(tail.text.startsWith('line '), tail.text);
		assert.equal(Buffer.byteLength(tail.text), tail.to - tail.from);
		assert.equal(tail.status, 'interrupted');

		const earlier = await reader.read('Devin', file, { from: tail.from - 40, to: tail.from });
		assert.equal(earlier.to, tail.from);
		assert.ok(earlier.text.startsWith('line '), earlier.text);
		assert.ok(earlier.text.endsWith('\n'));

		const whole = await reader.read('Devin', file, { from: 0, to: size });
		assert.equal(whole.text, body);

		// Mid-character offsets never produce a broken character.
		const tick = body.indexOf('✓');
		const mid = await reader.read('Devin', file, { from: Buffer.byteLength(body.slice(0, tick)) + 1 });
		assert.ok(!mid.text.includes('�'));

		writeFileSync(path, `${body}[runner] Agent exited with code 0\n`);
		const more = await reader.read('Devin', file, { from: tail.to });
		assert.equal(more.from, size);
		assert.equal(more.text, '[runner] Agent exited with code 0\n');
		assert.equal(more.exitCode, 0);
		assert.equal(more.status, 'ok');

		const none = await reader.read('Devin', file, { from: more.to });
		assert.equal(none.text, '');
		assert.equal(none.from, none.to);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
