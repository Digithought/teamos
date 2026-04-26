import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMessagingAdapter } from './file.mjs';

async function withAdapter(fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-msg-'));
	const adapter = new FileMessagingAdapter(dir);
	try {
		await fn(adapter, dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function withRosterAdapter(names, fn) {
	await withAdapter(async (adapter, dir) => {
		const members = names.map((name) => ({ name }));
		await writeFile(join(dir, 'members.json'), JSON.stringify({ members }), 'utf-8');
		await fn(adapter, dir);
	});
}

test('sendMessage writes master store + recipient inboxes + sender sent', async () => {
	await withAdapter(async (adapter) => {
		const { id } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			subject: 'hello',
			body: 'hi',
		});

		const inbox = await adapter.listInbox('bob');
		assert.equal(inbox.length, 1);
		assert.equal(inbox[0].id, id);
		assert.equal(inbox[0].from, 'alice');

		const sent = await adapter.listSent('alice');
		assert.equal(sent.length, 1);
		assert.equal(sent[0].id, id);
	});
});

test('supersedeMessage removes predecessor from unread inbox and delivers consolidated', async () => {
	await withAdapter(async (adapter) => {
		const { id: id1 } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			subject: 'auth review',
			body: 'first take',
		});
		const {
			id: id2,
			unreadRemoved,
			alreadyDelivered,
		} = await adapter.supersedeMessage({
			from: 'alice',
			supersedes: [id1],
			to: ['bob'],
			body: 'consolidated take',
		});

		assert.equal(unreadRemoved, 1, 'predecessor pulled from bob inbox');
		assert.equal(alreadyDelivered, 0);

		const inbox = await adapter.listInbox('bob');
		assert.equal(inbox.length, 1);
		assert.equal(inbox[0].id, id2);
		assert.deepEqual(inbox[0].supersedes, [id1]);

		// Subject defaulted from predecessor
		assert.equal(inbox[0].subject, 'auth review');

		// Sender's sent log keeps both, marked
		const sent = await adapter.listSent('alice');
		assert.equal(sent.length, 2);
		const supersededEntry = sent.find((e) => e.id === id1);
		assert.equal(supersededEntry.supersededBy, id2);
	});
});

test('supersedeMessage leaves archived predecessor alone but marks supersededBy', async () => {
	await withAdapter(async (adapter) => {
		const { id: id1 } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			subject: 'auth review',
			body: 'first take',
		});
		await adapter.archiveMessage('bob', id1);

		const {
			id: id2,
			unreadRemoved,
			alreadyDelivered,
		} = await adapter.supersedeMessage({
			from: 'alice',
			supersedes: [id1],
			to: ['bob'],
			body: 'consolidated take',
		});

		assert.equal(unreadRemoved, 0);
		assert.equal(alreadyDelivered, 1);

		// Inbox shows only the new message
		const inbox = await adapter.listInbox('bob');
		assert.equal(inbox.length, 1);
		assert.equal(inbox[0].id, id2);

		// Archive collapse hides the predecessor because the consolidated
		// version is reachable in bob's inbox.
		const archives = await adapter.listArchives('bob');
		assert.equal(archives.length, 0);

		// But the master store still has it, with supersededBy set.
		const archived = await adapter.readMessage(id1, { inlineParent: false });
		assert.equal(archived.supersededBy, id2);
	});
});

test('supersedeMessage handles mixed-state recipients (one unread, one archived)', async () => {
	await withAdapter(async (adapter) => {
		const { id: id1 } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob', 'carol'],
			subject: 'auth review',
			body: 'first take',
		});
		// Carol acted fast.
		await adapter.archiveMessage('carol', id1);

		const {
			id: id2,
			unreadRemoved,
			alreadyDelivered,
		} = await adapter.supersedeMessage({
			from: 'alice',
			supersedes: [id1],
			to: ['bob', 'carol'],
			body: 'consolidated',
		});

		assert.equal(unreadRemoved, 1, 'pulled from bob');
		assert.equal(alreadyDelivered, 1, 'left in carol archive');

		const bobInbox = await adapter.listInbox('bob');
		assert.equal(bobInbox.length, 1);
		assert.equal(bobInbox[0].id, id2);

		const carolInbox = await adapter.listInbox('carol');
		assert.equal(carolInbox.length, 1);
		assert.equal(carolInbox[0].id, id2);

		const carolArchives = await adapter.listArchives('carol');
		assert.equal(carolArchives.length, 0, 'collapse hides predecessor');
	});
});

test('supersedeMessage rejects narrowing the audience', async () => {
	await withAdapter(async (adapter) => {
		const { id: id1 } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob', 'carol'],
			subject: 'broad',
			body: 'x',
		});
		await assert.rejects(
			() => adapter.supersedeMessage({ from: 'alice', supersedes: [id1], to: ['bob'], body: 'narrow' }),
			/recipients must cover/,
		);
	});
});

test("supersedeMessage rejects superseding someone else's message", async () => {
	await withAdapter(async (adapter) => {
		const { id: id1 } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			subject: 'mine',
			body: 'x',
		});
		await assert.rejects(
			() => adapter.supersedeMessage({ from: 'carol', supersedes: [id1], to: ['bob'], body: 'not mine' }),
			/only the original sender/,
		);
	});
});

test('supersedeMessage rejects double-superseding', async () => {
	await withAdapter(async (adapter) => {
		const { id: id1 } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			subject: 't',
			body: 'a',
		});
		const { id: id2 } = await adapter.supersedeMessage({
			from: 'alice',
			supersedes: [id1],
			to: ['bob'],
			body: 'b',
		});
		await assert.rejects(
			() => adapter.supersedeMessage({ from: 'alice', supersedes: [id1], to: ['bob'], body: 'c' }),
			new RegExp(`already superseded by ${id2}`),
		);
	});
});

test('supersedeMessage can consolidate multiple predecessors', async () => {
	await withAdapter(async (adapter) => {
		const { id: id1 } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			subject: 'p1',
			body: 'one',
		});
		const { id: id2 } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			subject: 'p2',
			body: 'two',
		});
		const { id: id3, unreadRemoved } = await adapter.supersedeMessage({
			from: 'alice',
			supersedes: [id1, id2],
			to: ['bob'],
			body: 'merged',
		});
		assert.equal(unreadRemoved, 2);

		const inbox = await adapter.listInbox('bob');
		assert.equal(inbox.length, 1);
		assert.equal(inbox[0].id, id3);
		assert.deepEqual(inbox[0].supersedes, [id1, id2]);
	});
});

test('listSent filters by recipient intersection (to + cc)', async () => {
	await withAdapter(async (adapter) => {
		await adapter.sendMessage({ from: 'alice', to: ['bob'], subject: 's1', body: 'x' });
		await adapter.sendMessage({ from: 'alice', to: ['carol'], cc: ['bob'], subject: 's2', body: 'x' });
		await adapter.sendMessage({ from: 'alice', to: ['dave'], subject: 's3', body: 'x' });

		const all = await adapter.listSent('alice');
		assert.equal(all.length, 3);

		const toBob = await adapter.listSent('alice', { to: ['bob'] });
		assert.equal(toBob.length, 2);
		assert.ok(toBob.every((e) => [...(e.to ?? []), ...(e.cc ?? [])].includes('bob')));

		const toDave = await adapter.listSent('alice', { to: ['dave'] });
		assert.equal(toDave.length, 1);
		assert.equal(toDave[0].subject, 's3');

		const toMissing = await adapter.listSent('alice', { to: ['eve'] });
		assert.equal(toMissing.length, 0);
	});
});

test('readMessage surfaces supersedes and supersededBy', async () => {
	await withAdapter(async (adapter) => {
		const { id: id1 } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			subject: 't',
			body: 'a',
		});
		const { id: id2 } = await adapter.supersedeMessage({
			from: 'alice',
			supersedes: [id1],
			to: ['bob'],
			body: 'b',
		});

		const newMsg = await adapter.readMessage(id2);
		assert.deepEqual(newMsg.supersedes, [id1]);
		assert.equal(newMsg.supersededBy, undefined);

		const oldMsg = await adapter.readMessage(id1);
		assert.equal(oldMsg.supersededBy, id2);
		assert.equal(oldMsg.body, 'a', 'predecessor body unchanged — audit trail preserved');
	});
});

test('predecessor frontmatter rewrite preserves all original fields', async () => {
	await withAdapter(async (adapter) => {
		const { id: id1 } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			cc: ['carol'],
			subject: 'kept',
			body: 'original body',
			projectCode: 'AUTH',
		});
		await adapter.supersedeMessage({
			from: 'alice',
			supersedes: [id1],
			to: ['bob', 'carol'],
			body: 'consolidated',
		});

		const reread = await adapter.readMessage(id1, { inlineParent: false });
		assert.equal(reread.subject, 'kept');
		assert.equal(reread.projectCode, 'AUTH');
		assert.deepEqual(reread.cc, ['carol']);
		assert.equal(reread.body, 'original body');
		assert.ok(reread.supersededBy);
	});
});

// ─── Roster validation ──────────────────────────────────────────────────────

test('sendMessage rejects from with wrong case vs roster', async () => {
	await withRosterAdapter(['alice', 'bob'], async (adapter) => {
		await assert.rejects(
			() => adapter.sendMessage({ from: 'Alice', to: ['bob'], subject: 's', body: 'b' }),
			/does not match roster case.*declares "alice"/,
		);
	});
});

test('sendMessage rejects recipient with wrong case vs roster', async () => {
	await withRosterAdapter(['alice', 'bob'], async (adapter) => {
		await assert.rejects(
			() => adapter.sendMessage({ from: 'alice', to: ['Bob'], subject: 's', body: 'b' }),
			/does not match roster case.*declares "bob"/,
		);
		await assert.rejects(
			() => adapter.sendMessage({ from: 'alice', to: ['bob'], cc: ['Bob'], subject: 's', body: 'b' }),
			/does not match roster case/,
		);
	});
});

test('sendMessage rejects unknown member', async () => {
	await withRosterAdapter(['alice', 'bob'], async (adapter) => {
		await assert.rejects(
			() => adapter.sendMessage({ from: 'mallory', to: ['bob'], subject: 's', body: 'b' }),
			/not in members\.json/,
		);
	});
});

test('sendMessage accepts exact roster casing (capitalized roster)', async () => {
	await withRosterAdapter(['Alice', 'Bob'], async (adapter) => {
		const { id } = await adapter.sendMessage({
			from: 'Alice',
			to: ['Bob'],
			subject: 's',
			body: 'b',
		});
		assert.ok(id);
		const sent = await adapter.listSent('Alice');
		assert.equal(sent.length, 1);
	});
});

test('supersedeMessage also enforces roster casing', async () => {
	await withRosterAdapter(['alice', 'bob'], async (adapter) => {
		const { id } = await adapter.sendMessage({
			from: 'alice',
			to: ['bob'],
			subject: 's',
			body: 'b',
		});
		await assert.rejects(
			() =>
				adapter.supersedeMessage({
					from: 'Alice',
					supersedes: [id],
					to: ['bob'],
					body: 'x',
				}),
			/does not match roster case/,
		);
	});
});
