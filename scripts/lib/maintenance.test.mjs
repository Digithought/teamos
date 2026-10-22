import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRecentLogs } from './maintenance.mjs';

const logName = (member, ageMs) =>
	`${member}.pressing.${new Date(Date.now() - ageMs).toISOString().replace(/[:.]/g, '-')}.log`;

test('scanRecentLogs reads cost and time from every result line, wherever it sits', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'teamos-scan-'));
	try {
		// Final summary echoed after the marker pushes it well back from EOF.
		writeFileSync(join(dir, logName('Devin', 60_000)),
			`[session a]\n[RESULT DONE | 3101.9s | cost $15.8232]\n${'summary echo\n'.repeat(150)}\n[runner] Agent exited with code 0\n`);
		// A resumed invocation appends a near-zero marker after the real one.
		writeFileSync(join(dir, logName('Devin', 120_000)),
			`[session b]\n[RESULT DONE | 900.0s | cost $14.4744]\n${'x'.repeat(1800)}\n[RESULT DONE | 2.0s | cost $0.0000]\n[runner] Agent exited with code 0\n`);
		const entries = await scanRecentLogs(dir);
		assert.deepEqual(entries.map(e => [e.cost, e.durationSec]), [[15.8232, 3101.9], [14.4744, 902]]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
