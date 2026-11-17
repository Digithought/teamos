import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultDeadline, FileMessagingAdapter, isOverdue, MessageValidationError } from './file.mjs';

// Nate is the human; Ada and Bo are agents.
async function withTeam(fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-ask-'));
	const members = [
		{ name: 'Nate', type: 'human' },
		{ name: 'Ada', type: 'ai' },
		{ name: 'Bo', type: 'ai' },
	];
	await writeFile(join(dir, 'members.json'), JSON.stringify({ members }), 'utf-8');
	try {
		await fn(new FileMessagingAdapter(dir), dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const isoDate = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const FUTURE = isoDate(3);

const decide = (extra = {}) => ({
	from: 'Ada',
	to: ['Nate'],
	subject: 'Drop the legacy importer?',
	body: 'Context... Options... I recommend dropping it.',
	ask: 'decide',
	default: 'Drop it',
	defaultBy: FUTURE,
	...extra,
});

/** Write a decide whose defaultBy has already passed (sending one is refused). */
async function overdueDecide(adapter, dir) {
	const { id } = await adapter.sendMessage(decide());
	const path = join(dir, 'messages', `${id}.md`);
	const raw = await readFile(path, 'utf-8');
	await writeFile(path, raw.replace(`defaultBy: ${FUTURE}`, `defaultBy: ${isoDate(-2)}`), 'utf-8');
	return id;
}

async function rejects(promise, pattern) {
	await assert.rejects(promise, (err) => {
		assert.ok(err instanceof MessageValidationError, `expected a MessageValidationError, got ${err}`);
		assert.equal(err.status, 400);
		assert.match(err.message, pattern);
		return true;
	});
}

test('an initiated message to a human without ask is refused, saying how to fix it', async () => {
	await withTeam(async (adapter) => {
		await rejects(
			adapter.sendMessage({ from: 'Ada', to: ['Nate'], subject: 'Status', body: 'All green' }),
			/Nate is a human member[\s\S]*ask: "decide"[\s\S]*ask: "fyi"/,
		);
		// Cc counts too.
		await rejects(
			adapter.sendMessage({ from: 'Ada', to: ['Bo'], cc: ['Nate'], subject: 'Status', body: 'All green' }),
			/human member/,
		);
		assert.deepEqual(await adapter.listInbox('Nate'), []);
		assert.deepEqual(await adapter.listInbox('Bo'), []);
	});
});

test('an unknown ask value is refused', async () => {
	await withTeam(async (adapter) => {
		await rejects(adapter.sendMessage(decide({ ask: 'urgent' })), /ask must be "decide" or "fyi"/);
	});
});

test('a decide without default or defaultBy, or with a bad or past defaultBy, is refused', async () => {
	await withTeam(async (adapter) => {
		await rejects(adapter.sendMessage(decide({ default: undefined })), /needs `default`/);
		await rejects(adapter.sendMessage(decide({ default: '  ' })), /needs `default`/);
		await rejects(adapter.sendMessage(decide({ defaultBy: undefined })), /needs `defaultBy`/);
		await rejects(adapter.sendMessage(decide({ defaultBy: 'next friday' })), /must be an ISO date/);
		await rejects(adapter.sendMessage(decide({ defaultBy: isoDate(-1) })), /already passed/);
		await rejects(adapter.sendMessage(decide({ default: 'x'.repeat(301) })), /one line/);
	});
});

test('a decide to agents only, or default on an fyi, is refused', async () => {
	await withTeam(async (adapter) => {
		await rejects(adapter.sendMessage(decide({ to: ['Bo'] })), /no recipient is human/);
		await rejects(adapter.sendMessage(decide({ ask: 'fyi' })), /only apply to ask: "decide"/);
	});
});

test('a valid decide is stored and delivered to the human inbox', async () => {
	await withTeam(async (adapter) => {
		const { id } = await adapter.sendMessage(decide({ default: 'Drop it\nfrom: Nate' }));
		const msg = await adapter.readMessage(id);
		assert.equal(msg.ask, 'decide');
		// A newline can't smuggle in another frontmatter field.
		assert.equal(msg.default, 'Drop it from: Nate');
		assert.equal(msg.from, 'Ada');
		assert.equal(msg.defaultBy, FUTURE);
		const inbox = await adapter.listInbox('Nate');
		assert.equal(inbox.length, 1);
		assert.equal(inbox[0].ask, 'decide');
		assert.equal(inbox[0].defaultBy, FUTURE);
	});
});

test('an fyi skips the human inbox but reaches agent inboxes', async () => {
	await withTeam(async (adapter) => {
		const { id } = await adapter.sendMessage({
			from: 'Ada',
			to: ['Nate', 'Bo'],
			subject: 'Shipped 1.4',
			body: 'done',
			ask: 'fyi',
		});
		assert.deepEqual(await adapter.listInbox('Nate'), []);
		assert.deepEqual(
			(await adapter.listArchives('Nate')).map((m) => m.id),
			[id],
		);
		assert.deepEqual(
			(await adapter.listInbox('Bo')).map((m) => m.id),
			[id],
		);
	});
});

test('replies, agent-to-agent mail and the human own mail need no ask', async () => {
	await withTeam(async (adapter) => {
		const { id: q } = await adapter.sendMessage(decide());
		const { id: r1 } = await adapter.sendMessage({ from: 'Nate', to: ['Ada'], replyTo: q, body: 'Why not keep it?' });
		await adapter.sendMessage({ from: 'Ada', to: ['Nate'], replyTo: r1, body: 'It has no users.' });
		await adapter.sendMessage({ from: 'Ada', to: ['Bo'], subject: 'Pairing', body: 'later?' });
		await adapter.sendMessage({ from: 'Nate', to: ['Ada'], subject: 'New idea', body: 'hmm' });
		// Mail without a roster (test harnesses, legacy teams) is not checked either.
	});
	const dir = await mkdtemp(join(tmpdir(), 'teamos-ask-'));
	try {
		await new FileMessagingAdapter(dir).sendMessage({ from: 'a', to: ['b'], subject: 's', body: 'b' });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('a human reply anywhere down the thread resolves the decide and files it', async () => {
	await withTeam(async (adapter) => {
		const { id: q } = await adapter.sendMessage(decide());
		const { id: follow } = await adapter.sendMessage({ from: 'Ada', to: ['Nate'], replyTo: q, body: 'One more detail.' });
		const { id: answer } = await adapter.sendMessage({ from: 'Nate', to: ['Ada'], replyTo: follow, body: 'Keep it.' });
		const msg = await adapter.readMessage(q);
		assert.equal(msg.resolvedBy, answer);
		assert.equal(msg.resolution, 'answered');
		assert.ok(msg.resolvedAt);
		// The question left the inbox; the follow-up reply is still there.
		assert.deepEqual(
			(await adapter.listInbox('Nate')).map((m) => m.id),
			[follow],
		);
		assert.ok((await adapter.listArchives('Nate')).some((m) => m.id === q));
	});
});

test('resolves: the sender may close an overdue decide; it is filed quietly and threads under it', async () => {
	await withTeam(async (adapter, dir) => {
		const q = await overdueDecide(adapter, dir);
		const { id } = await adapter.sendMessage({ from: 'Ada', to: ['Nate'], body: 'Applied the default.', resolves: q });
		const note = await adapter.readMessage(id);
		assert.equal(note.replyTo, q);
		assert.equal(note.subject, 'Re: Drop the legacy importer?');
		assert.equal(note.resolves, q);
		const closed = await adapter.readMessage(q);
		assert.equal(closed.resolvedBy, id);
		assert.equal(closed.resolution, 'default-applied');
		assert.deepEqual(await adapter.listInbox('Nate'), []);
		await rejects(
			adapter.sendMessage({ from: 'Ada', to: ['Nate'], body: 'again', resolves: q }),
			/already resolved/,
		);
	});
});

test('resolves is refused before defaultBy, from someone else, or on a non-decide', async () => {
	await withTeam(async (adapter, dir) => {
		const { id: early } = await adapter.sendMessage(decide());
		await rejects(
			adapter.sendMessage({ from: 'Ada', to: ['Nate'], body: 'x', resolves: early }),
			/not due until after/,
		);
		const late = await overdueDecide(adapter, dir);
		await rejects(adapter.sendMessage({ from: 'Bo', to: ['Nate'], body: 'x', resolves: late }), /only the sender/);
		const { id: plain } = await adapter.sendMessage({ from: 'Ada', to: ['Bo'], subject: 's', body: 'b' });
		await rejects(adapter.sendMessage({ from: 'Ada', to: ['Bo'], body: 'x', resolves: plain }), /not an ask/);
		await rejects(adapter.sendMessage({ from: 'Ada', to: ['Bo'], body: 'x', resolves: 'nope' }), /not found/);
	});
});

test('supersedeMessage enforces ask the same way and carries it', async () => {
	await withTeam(async (adapter) => {
		const { id: first } = await adapter.sendMessage(decide());
		await rejects(
			adapter.supersedeMessage({ from: 'Ada', supersedes: [first], to: ['Nate'], body: 'v2' }),
			/human member/,
		);
		await rejects(
			adapter.supersedeMessage({ from: 'Ada', supersedes: [first], to: ['Nate'], body: 'v2', ask: 'decide' }),
			/needs `default`/,
		);
		const { id } = await adapter.supersedeMessage({
			from: 'Ada',
			supersedes: [first],
			to: ['Nate'],
			body: 'Never mind, moot.',
			ask: 'fyi',
		});
		assert.equal((await adapter.readMessage(id)).ask, 'fyi');
		// The superseded question left the inbox and the fyi skipped it.
		assert.deepEqual(await adapter.listInbox('Nate'), []);
	});
});

test('legacy messages without ask still load as untagged', async () => {
	await withTeam(async (adapter, dir) => {
		await adapter.sendMessage({ from: 'Ada', to: ['Bo'], subject: 's', body: 'b' });
		const legacy = '2026-01-01T00-00-00.000Z-old0';
		await writeFile(
			join(dir, 'messages', `${legacy}.md`),
			`---\nid: ${legacy}\nfrom: Ada\nto: [Nate]\nsubject: Old status\nsentAt: 2026-01-01T00:00:00.000Z\n---\n\nhello\n`,
			'utf-8',
		);
		await mkdir(join(dir, 'members', 'Nate'), { recursive: true });
		await writeFile(join(dir, 'members', 'Nate', 'inbox.json'), JSON.stringify({ items: [legacy] }), 'utf-8');
		const [entry] = await adapter.listInbox('Nate');
		assert.equal(entry.id, legacy);
		assert.equal(entry.ask, undefined);
		assert.equal((await adapter.readMessage(legacy)).ask, undefined);
	});
});

test('defaultDeadline: a bare date runs to the end of the day, UTC', () => {
	assert.equal(defaultDeadline('2026-11-20'), Date.parse('2026-11-20T23:59:59.999Z'));
	assert.equal(defaultDeadline('2026-11-20T17:00:00Z'), Date.parse('2026-11-20T17:00:00Z'));
	assert.ok(Number.isNaN(defaultDeadline('soon')));
	assert.equal(isOverdue({ defaultBy: '2026-11-20' }, Date.parse('2026-11-20T23:00:00Z')), false);
	assert.equal(isOverdue({ defaultBy: '2026-11-20' }, Date.parse('2026-11-21T00:00:00Z')), true);
	assert.equal(isOverdue({}), false);
});

test('a reply that adds a human who was not on the parent counts as initiated', async () => {
	await withTeam(async (adapter) => {
		const { id: parent } = await adapter.sendMessage({ from: 'Ada', to: ['Bo'], subject: 'Pairing', body: 'later?' });
		await rejects(
			adapter.sendMessage({ from: 'Bo', to: ['Ada'], cc: ['Nate'], replyTo: parent, body: 'sure' }),
			/Nate is a human member not on the message you are replying to[\s\S]*counts as starting one/,
		);
		// The same decide validation applies.
		await rejects(
			adapter.sendMessage({ from: 'Bo', to: ['Nate'], replyTo: parent, body: 'Pick one?', ask: 'decide' }),
			/needs `default`/,
		);
		const { id } = await adapter.sendMessage({ from: 'Bo', to: ['Ada'], cc: ['Nate'], replyTo: parent, body: 'fyi', ask: 'fyi' });
		assert.deepEqual(await adapter.listInbox('Nate'), []);
		assert.equal((await adapter.readMessage(id)).ask, 'fyi');
		await adapter.sendMessage(decide({ from: 'Bo', replyTo: parent }));
		assert.equal((await adapter.listInbox('Nate')).length, 1);
	});
});

test('a reply to a human already on the parent stays exempt, as from, to or cc', async () => {
	await withTeam(async (adapter) => {
		const { id: fromNate } = await adapter.sendMessage({ from: 'Nate', to: ['Ada'], subject: 'Idea', body: 'hmm' });
		await adapter.sendMessage({ from: 'Ada', to: ['Nate'], replyTo: fromNate, body: 'ok' });
		const { id: ccNate } = await adapter.sendMessage({ from: 'Ada', to: ['Bo'], cc: ['Nate'], subject: 'Ship', body: 'x', ask: 'fyi' });
		await adapter.sendMessage({ from: 'Bo', to: ['Ada', 'Nate'], replyTo: ccNate, body: 'done' });
	});
});

test('a reply to a parent that cannot be read treats every human as new', async () => {
	await withTeam(async (adapter) => {
		await rejects(
			adapter.sendMessage({ from: 'Ada', to: ['Nate'], replyTo: '2026-01-01T00-00-00.000Z-gone', subject: 's', body: 'x' }),
			/counts as starting one/,
		);
	});
});
