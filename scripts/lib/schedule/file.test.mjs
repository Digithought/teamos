import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileScheduleAdapter } from './file.mjs';

async function withAdapter(fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-schedule-'));
	try {
		await fn(new FileScheduleAdapter(dir));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('systemKey survives a rename and cadence change via updateEvent', async () => {
	await withAdapter(async (adapter) => {
		const { id } = await adapter.addEvent('alice', {
			title: 'Daily Check-in',
			description: 'Daily check-in following the rules in teamos/agent-rules/daily-checkin.md.',
			time: '2026-04-15T09:00:00.000Z',
			recurrence: { frequency: 'daily', interval: 1 },
			systemKey: 'daily-checkin',
		});
		await adapter.updateEvent('alice', id, {
			title: 'Weekly Check-in',
			description: 'Weekly check-in, converted from daily — rules unchanged.',
			recurrence: { frequency: 'weekly', interval: 1 },
		});
		assert.equal(await adapter.hasEventWithSystemKey('alice', 'daily-checkin'), true);
	});
});

test('a legacy event with the canonical description is backfilled with its systemKey', async () => {
	await withAdapter(async (adapter) => {
		// No systemKey — mimics a file written before the field existed.
		await adapter.addEvent('bob', {
			title: 'Daily Check-in',
			description: 'Daily check-in following the rules in teamos/agent-rules/daily-checkin.md.',
			time: '2026-04-15T09:00:00.000Z',
			recurrence: { frequency: 'daily', interval: 1 },
		});
		assert.equal(await adapter.hasEventWithSystemKey('bob', 'daily-checkin'), true);
	});
});

test('a legacy event renamed in place is still backfilled as long as the description cites the rule file', async () => {
	await withAdapter(async (adapter) => {
		const { id } = await adapter.addEvent('carol', {
			title: 'Daily Check-in',
			description: 'Daily check-in following the rules in teamos/agent-rules/daily-checkin.md.',
			time: '2026-04-15T09:00:00.000Z',
			recurrence: { frequency: 'daily', interval: 1 },
		});
		// Simulates the pre-fix bug: a member customizes title + cadence (and
		// rewrites the description) but keeps citing the governing rule file.
		await adapter.updateEvent('carol', id, {
			title: 'Weekly Check-in',
			description:
				'Weekly check-in following the rules in teamos/agent-rules/daily-checkin.md. Converted from daily → weekly.',
			recurrence: { frequency: 'weekly', interval: 1 },
		});
		assert.equal(await adapter.hasEventWithSystemKey('carol', 'daily-checkin'), true);
	});
});

test('an unrelated event never matches a systemKey', async () => {
	await withAdapter(async (adapter) => {
		await adapter.addEvent('dana', { title: 'Team sync', time: '2026-04-15T09:00:00.000Z' });
		assert.equal(await adapter.hasEventWithSystemKey('dana', 'daily-checkin'), false);
	});
});
