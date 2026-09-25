import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileWatchesAdapter } from './file.mjs';

// Probes are plain commands; `node -e` gives us deterministic ones without
// shipping fixture scripts.
const PROBES = {
	quiet: { command: process.execPath, args: ['-e', ''] },
	noisy: { command: process.execPath, args: ['-e', 'process.stdout.write("down\\n")'] },
	failing: { command: process.execPath, args: ['-e', 'process.exit(3)'] },
	echoing: { command: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])'], params: ['text'] },
	missing: { command: join(tmpdir(), 'teamos-no-such-binary') },
	hanging: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 500 },
};

async function withAdapter(probes, fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-watch-'));
	const adapter = new FileWatchesAdapter(dir, dir, probes);
	try {
		await fn(adapter, dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Observation state lives outside team/members — read it from the .logs tree. */
async function readObserved(adapter, member) {
	return JSON.parse(await readFile(adapter._observedPath(member), 'utf-8')).observed;
}

/** Re-poll ignoring the per-member throttle, with a controllable `now`. */
async function repoll(adapter, member, now = new Date()) {
	adapter._lastPollAt.delete(member);
	await adapter.poll(member, now);
}

test('addWatch rejects an unknown probe name', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await assert.rejects(() => adapter.addWatch('alice', { probe: 'nope', priority: 'today' }), /unknown probe "nope"/);
	});
});

test('a hand-edited unsafe parameter is rejected at poll time, not executed', async () => {
	// Members can reach watched.json with a plain editor, so `add_watch` validation
	// alone would leave the probe's argv one text edit away from an injected option.
	await withAdapter(PROBES, async (adapter, dir) => {
		await adapter.addWatch('alice', { probe: 'echoing', priority: 'today', params: { text: 'safe' } });
		const path = join(dir, 'members', 'alice', 'watched.json');
		const state = JSON.parse(await readFile(path, 'utf-8'));
		state.items[0].params.text = '--injected';
		await writeFile(path, JSON.stringify(state));

		await repoll(adapter, 'alice');
		const entry = Object.values(await readObserved(adapter, 'alice'))[0];
		assert.equal(entry.status, 'error');
		assert.match(entry.latest?.error ?? entry.error ?? '', /must be a simple string/);
	});
});

test('addWatch rejects undeclared, missing, and unsafe parameters', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await assert.rejects(
			() => adapter.addWatch('alice', { probe: 'quiet', priority: 'today', params: { text: 'x' } }),
			/accepts no parameter "text"/,
		);
		await assert.rejects(
			() => adapter.addWatch('alice', { probe: 'echoing', priority: 'today' }),
			/requires parameter "text"/,
		);
		await assert.rejects(
			() => adapter.addWatch('alice', { probe: 'echoing', priority: 'today', params: { text: '--help' } }),
			/must be a simple string/,
		);
		await assert.rejects(
			() => adapter.addWatch('alice', { probe: 'echoing', priority: 'today', params: { text: 'a; rm -rf /' } }),
			/must be a simple string/,
		);
	});
});

test('addWatch validates priority and fires mode', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await assert.rejects(() => adapter.addWatch('alice', { probe: 'quiet', priority: 'urgent' }), /priority must be/);
		await assert.rejects(
			() => adapter.addWatch('alice', { probe: 'quiet', priority: 'today', fires: 'whenever' }),
			/fires must be/,
		);
	});
});

test('first poll is a silent baseline — adding a watch does not backfill a wake', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await adapter.addWatch('alice', { probe: 'noisy', priority: 'pressing' });
		await adapter.poll('alice');
		assert.deepEqual(await adapter.pendingObservations('alice'), []);
	});
});

test('a transition fires once and stays quiet while the condition holds', async () => {
	await withAdapter(PROBES, async (adapter) => {
		const { id } = await adapter.addWatch('alice', { probe: 'quiet', priority: 'pressing', cooldownMinutes: 0 });
		await adapter.poll('alice'); // baseline: clear

		// Probe now reports a hit.
		adapter.probes.get('quiet').args = PROBES.noisy.args;
		await repoll(adapter, 'alice');

		const pending = await adapter.pendingObservations('alice');
		assert.equal(pending.length, 1);
		assert.equal(pending[0].watchId, id);
		assert.equal(pending[0].status, 'hit');
		assert.equal(pending[0].previousStatus, 'clear');
		assert.match(pending[0].output, /down/);

		// Cycle succeeded — acknowledge, and the still-true condition is silent.
		await adapter.acknowledgeObservations('alice', pending);
		await repoll(adapter, 'alice');
		assert.deepEqual(await adapter.pendingObservations('alice'), []);

		// Recovery is a transition too.
		adapter.probes.get('quiet').args = PROBES.quiet.args;
		await repoll(adapter, 'alice');
		const recovered = await adapter.pendingObservations('alice');
		assert.equal(recovered.length, 1);
		assert.equal(recovered[0].status, 'clear');
	});
});

test('an unacknowledged transition re-fires (failed cycle does not swallow it)', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await adapter.addWatch('alice', { probe: 'quiet', priority: 'pressing', cooldownMinutes: 0 });
		await adapter.poll('alice');
		adapter.probes.get('quiet').args = PROBES.noisy.args;
		await repoll(adapter, 'alice');
		assert.equal((await adapter.pendingObservations('alice')).length, 1);

		// No acknowledge — the cycle failed. Same transition next pass.
		await repoll(adapter, 'alice');
		assert.equal((await adapter.pendingObservations('alice')).length, 1);
	});
});

test('fires: exitCode matches the declared code', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await adapter.addWatch('alice', {
			probe: 'quiet',
			priority: 'today',
			fires: 'exitCode',
			exitCode: 3,
			cooldownMinutes: 0,
		});
		await adapter.poll('alice'); // baseline: exit 0 → clear
		adapter.probes.get('quiet').args = PROBES.failing.args;
		await repoll(adapter, 'alice');
		const pending = await adapter.pendingObservations('alice');
		assert.equal(pending.length, 1);
		assert.equal(pending[0].status, 'hit');
		assert.equal(pending[0].exitCode, 3);
	});
});

test('fires: outputChanged fires on any change in output', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await adapter.addWatch('alice', {
			probe: 'echoing',
			priority: 'later',
			fires: 'outputChanged',
			params: { text: 'one' },
			cooldownMinutes: 0,
		});
		await adapter.poll('alice');
		assert.deepEqual(await adapter.pendingObservations('alice'), []);

		// Same output, no transition.
		await repoll(adapter, 'alice');
		assert.deepEqual(await adapter.pendingObservations('alice'), []);

		adapter.probes.get('echoing').args = ['-e', 'process.stdout.write("two")'];
		await repoll(adapter, 'alice');
		const pending = await adapter.pendingObservations('alice');
		assert.equal(pending.length, 1);
		assert.equal(pending[0].status, 'changed');
		assert.equal(pending[0].output, 'two');
	});
});

test('a transition observed mid-cycle is not acknowledged by that cycle — it reaches the next prompt', async () => {
	// 2026-09-25: a cycle started 05:24:26, the watch fired at 05:25:50, and the
	// clean exit acknowledged whatever was latest — the member never saw it.
	await withAdapter(PROBES, async (adapter) => {
		await adapter.addWatch('alice', { probe: 'quiet', priority: 'pressing', cooldownMinutes: 0 });
		await adapter.poll('alice'); // baseline: clear

		const delivered = await adapter.pendingObservations('alice'); // prompt built: nothing fired
		adapter.probes.get('quiet').args = PROBES.noisy.args;
		await repoll(adapter, 'alice'); // fires while the cycle runs
		await adapter.acknowledgeObservations('alice', delivered); // cycle exits 0

		const next = await adapter.pendingObservations('alice');
		assert.equal(next.length, 1);
		assert.equal(next[0].status, 'hit');

		// Shown "hit", then it recovers mid-cycle: the recovery is still news.
		adapter.probes.get('quiet').args = PROBES.quiet.args;
		await repoll(adapter, 'alice');
		await adapter.acknowledgeObservations('alice', next);
		const after = await adapter.pendingObservations('alice');
		assert.equal(after.length, 1);
		assert.equal(after[0].status, 'clear');
		assert.equal(after[0].previousStatus, 'hit');
	});
});

test('a probe that cannot run reports distinctly from one that reported nothing', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await adapter.addWatch('alice', { probe: 'quiet', priority: 'today', cooldownMinutes: 0 });
		await adapter.poll('alice'); // baseline: clear
		adapter.probes.get('quiet').command = PROBES.missing.command;
		await repoll(adapter, 'alice');

		const pending = await adapter.pendingObservations('alice');
		assert.equal(pending.length, 1);
		assert.equal(pending[0].status, 'error');
		assert.ok(pending[0].error);

		// The same failure is not a new transition.
		await adapter.acknowledgeObservations('alice', pending);
		await repoll(adapter, 'alice');
		assert.deepEqual(await adapter.pendingObservations('alice'), []);
	});
});

test('a hanging probe is killed at its timeout and reported as an error', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await adapter.addWatch('alice', { probe: 'hanging', priority: 'today', cooldownMinutes: 0 });
		await adapter.poll('alice'); // baseline is itself the timeout error
		const [observed] = Object.values(await readObserved(adapter, 'alice'));
		assert.equal(observed.status, 'error');
		assert.match(observed.latest.error, /timed out/);
	});
});

test('cooldown suppresses a re-fire, and a flap inside it resolves to nothing', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await adapter.addWatch('alice', { probe: 'quiet', priority: 'pressing', cooldownMinutes: 30 });
		const t0 = new Date('2026-04-23T12:00:00.000Z');
		await adapter.poll('alice', t0);

		adapter.probes.get('quiet').args = PROBES.noisy.args;
		await repoll(adapter, 'alice', new Date('2026-04-23T12:01:00.000Z'));
		const fired = await adapter.pendingObservations('alice');
		assert.equal(fired.length, 1);
		await adapter.acknowledgeObservations('alice', fired, new Date('2026-04-23T12:01:00.000Z'));

		// Flaps back 2 minutes later — inside the cooldown, so nothing fires.
		adapter.probes.get('quiet').args = PROBES.quiet.args;
		await repoll(adapter, 'alice', new Date('2026-04-23T12:03:00.000Z'));
		assert.deepEqual(await adapter.pendingObservations('alice', new Date('2026-04-23T12:03:00.000Z')), []);

		// Flaps back to the acknowledged state — by cooldown expiry there is no
		// transition left to report.
		adapter.probes.get('quiet').args = PROBES.noisy.args;
		await repoll(adapter, 'alice', new Date('2026-04-23T12:40:00.000Z'));
		assert.deepEqual(await adapter.pendingObservations('alice', new Date('2026-04-23T12:40:00.000Z')), []);

		// A genuine change after the cooldown does fire.
		adapter.probes.get('quiet').args = PROBES.quiet.args;
		await repoll(adapter, 'alice', new Date('2026-04-23T12:41:00.000Z'));
		const pending = await adapter.pendingObservations('alice', new Date('2026-04-23T12:41:00.000Z'));
		assert.equal(pending.length, 1);
		assert.equal(pending[0].status, 'clear');
	});
});

test('hasPendingObservations respects the priority ceiling', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await adapter.addWatch('alice', { probe: 'quiet', priority: 'thisWeek', cooldownMinutes: 0 });
		await adapter.poll('alice');
		adapter.probes.get('quiet').args = PROBES.noisy.args;
		await repoll(adapter, 'alice');
		assert.equal(await adapter.hasPendingObservations('alice', 'pressing'), false);
		assert.equal(await adapter.hasPendingObservations('alice', 'thisWeek'), true);
		assert.equal(await adapter.hasPendingObservations('alice', 'later'), true);
	});
});

test('poll is throttled per member', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await adapter.addWatch('alice', { probe: 'quiet', priority: 'today', cooldownMinutes: 0 });
		await adapter.poll('alice');
		adapter.probes.get('quiet').args = PROBES.noisy.args;
		await adapter.poll('alice'); // within the throttle window — no probe run
		assert.deepEqual(await adapter.pendingObservations('alice'), []);
	});
});

test('removeWatch drops the watch and its observation state', async () => {
	await withAdapter(PROBES, async (adapter) => {
		const { id } = await adapter.addWatch('alice', { probe: 'noisy', priority: 'today' });
		await adapter.poll('alice');
		await adapter.removeWatch('alice', id);
		assert.deepEqual(await adapter.listWatches('alice'), []);
		assert.deepEqual(await readObserved(adapter, 'alice'), {});
		await assert.rejects(() => adapter.removeWatch('alice', id), /is not in alice's watches/);
	});
});

test('watches are per-member', async () => {
	await withAdapter(PROBES, async (adapter) => {
		await adapter.addWatch('alice', { probe: 'noisy', priority: 'today' });
		assert.equal((await adapter.listWatches('alice')).length, 1);
		assert.deepEqual(await adapter.listWatches('bob'), []);
	});
});

test('polling churns the observation file, never the synced subscription file', async () => {
	// The whole point of the split: team/ is git-synced, so a chatty probe must
	// not rewrite watched.json every pass.
	await withAdapter(PROBES, async (adapter) => {
		await adapter.addWatch('alice', { probe: 'noisy', priority: 'today', cooldownMinutes: 0 });
		const before = await readFile(adapter._path('alice'), 'utf-8');
		assert.equal(JSON.parse(before).observed, undefined);

		await adapter.poll('alice');
		adapter.probes.get('noisy').args = ['-e', 'process.stdout.write("still down\\n")'];
		await repoll(adapter, 'alice');

		assert.equal(await readFile(adapter._path('alice'), 'utf-8'), before);
		assert.equal(Object.keys(await readObserved(adapter, 'alice')).length, 1);
	});
});

test('a pre-split watched.json migrates its observed map instead of re-firing', async () => {
	await withAdapter(PROBES, async (adapter) => {
		const { id } = await adapter.addWatch('alice', { probe: 'noisy', priority: 'today', cooldownMinutes: 0 });
		await adapter.poll('alice'); // baseline: hit

		// Rewrite the file the way the pre-split adapter wrote it.
		const items = JSON.parse(await readFile(adapter._path('alice'), 'utf-8')).items;
		const observed = await readObserved(adapter, 'alice');
		await rm(adapter._observedPath('alice'));
		await writeFile(adapter._path('alice'), JSON.stringify({ items, observed }));

		// The acknowledged signature survives, so the still-true condition is silent.
		await repoll(adapter, 'alice');
		assert.deepEqual(await adapter.pendingObservations('alice'), []);

		// …and the observed map has moved out of the synced file.
		assert.equal(JSON.parse(await readFile(adapter._path('alice'), 'utf-8')).observed, undefined);
		assert.ok((await readObserved(adapter, 'alice'))[id]);
	});
});
