import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildInboxSection } from './cycle.mjs';
import { FileMessagingAdapter } from './messaging/file.mjs';
import { FileScheduleAdapter } from './schedule/file.mjs';
import { ensureDailyCheckinEvents, memberHasWork } from './work-detection.mjs';

async function withTeam(fn) {
	const dir = await mkdtemp(join(tmpdir(), 'teamos-work-'));
	const members = ['alice', 'bob', 'carol'].map((name) => ({ name }));
	await writeFile(join(dir, 'members.json'), JSON.stringify({ members }), 'utf-8');
	try {
		await fn(dir, new FileMessagingAdapter(dir));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('To-addressed mail is pressing work; Cc-only mail waits for today', async () => {
	await withTeam(async (dir, messaging) => {
		await messaging.sendMessage({ from: 'alice', to: ['bob'], cc: ['carol'], subject: 'Review', body: 'x' });
		const adapters = { messaging };
		assert.equal(await memberHasWork('bob', 'pressing', dir, adapters), true);
		assert.equal(await memberHasWork('carol', 'pressing', dir, adapters), false);
		assert.equal(await memberHasWork('carol', 'today', dir, adapters), true);
		assert.equal(await memberHasWork('carol', 'later', dir, adapters), true);
	});
});

test('a member in both To and Cc is treated as To', async () => {
	await withTeam(async (dir, messaging) => {
		await messaging.sendMessage({ from: 'alice', to: ['bob'], cc: ['bob'], subject: 'Both', body: 'x' });
		assert.equal(await memberHasWork('bob', 'pressing', dir, { messaging }), true);
	});
});

test('ensureDailyCheckinEvents does not re-inject after the member renames and re-cadences the event in place', async () => {
	await withTeam(async (dir) => {
		const schedule = new FileScheduleAdapter(dir);
		const members = [{ name: 'alice' }];
		await ensureDailyCheckinEvents(members, schedule);

		const [event] = await schedule.listEvents('alice');
		await schedule.updateEvent('alice', event.id, {
			title: 'Weekly Check-in',
			recurrence: { frequency: 'weekly', interval: 1 },
		});

		await ensureDailyCheckinEvents(members, schedule);

		const events = await schedule.listEvents('alice');
		assert.equal(events.length, 1, 'renaming the injected event must not cause a second one to be added');
	});
});

test('inbox prompt lists To-addressed mail before Cc-only mail', async () => {
	await withTeam(async (_dir, messaging) => {
		await messaging.sendMessage({ from: 'alice', to: ['bob'], subject: 'Direct', body: 'x' });
		// Sent later, so newer — it would sort first without the role split.
		await messaging.sendMessage({ from: 'alice', to: ['carol'], cc: ['bob'], subject: 'Copied', body: 'x' });
		const text = (await buildInboxSection('bob', messaging)).join('\n');
		const direct = text.indexOf('### Direct');
		const ccHeading = text.indexOf("Cc'd to you (1)");
		const copied = text.indexOf('### Copied');
		assert.ok(direct >= 0 && ccHeading > direct && copied > ccHeading, text);
	});
});
