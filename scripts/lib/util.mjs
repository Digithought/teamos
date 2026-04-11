import { readFile, access, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';

export const STOP_FILE = '.stop';

export async function pathExists(filePath) {
	try { await access(filePath, constants.R_OK); return true; } catch { return false; }
}

export async function readTextOrEmpty(filePath) {
	try { return await readFile(filePath, 'utf-8'); } catch { return ''; }
}

export async function checkStop(teamDir) {
	const stopFile = join(teamDir, STOP_FILE);
	if (await pathExists(stopFile)) {
		await unlink(stopFile).catch(() => {});
		return true;
	}
	return false;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatTimestamp() {
	const now = new Date();
	const day = DAY_NAMES[now.getDay()];
	const month = MONTH_NAMES[now.getMonth()];
	const date = now.getDate();
	const year = now.getFullYear();
	const offset = -now.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	const offH = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
	const offM = String(Math.abs(offset) % 60).padStart(2, '0');
	const h = String(now.getHours()).padStart(2, '0');
	const m = String(now.getMinutes()).padStart(2, '0');
	const isoLocal = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}T${h}:${m}:${String(now.getSeconds()).padStart(2, '0')}${sign}${offH}:${offM}`;
	return `${day}, ${month} ${date}, ${year} ${h}:${m} local (${isoLocal})`;
}

export function slugify(text) {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export async function ensureLogsDir(teamDir) {
	const logsDir = join(teamDir, '.logs');
	await mkdir(logsDir, { recursive: true });
	return logsDir;
}

export function buildLogPath(logsDir, label, priority) {
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	return join(logsDir, `${label}.${priority}.${ts}.log`);
}
