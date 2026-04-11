import type { Plugin } from 'vite';
import { readdir, readFile, writeFile, unlink, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface ApiOptions {
	teamDir: string;
	ticketsDir?: string;
	siblingDir?: string;
	siblingPort?: number;
}

function json(res: ServerResponse, data: unknown, status = 200) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (chunk: Buffer) => data += chunk);
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { meta: {}, body: content };
	const meta: Record<string, unknown> = {};
	for (const line of match[1].split('\n')) {
		const idx = line.indexOf(':');
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		let val: unknown = line.slice(idx + 1).trim();
		if (val === 'true') val = true;
		else if (val === 'false') val = false;
		else if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']'))
			val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
		meta[key] = val;
	}
	return { meta, body: match[2].trim() };
}

async function readJson(path: string, fallback: unknown = null): Promise<any> {
	try { return JSON.parse(await readFile(path, 'utf-8')); }
	catch { return fallback; }
}

async function readText(path: string, fallback = ''): Promise<string> {
	try { return await readFile(path, 'utf-8'); }
	catch { return fallback; }
}

async function listMdFiles(dir: string): Promise<string[]> {
	try {
		const files = await readdir(dir);
		return files.filter(f => f.endsWith('.md')).sort();
	} catch { return []; }
}

async function countMdFiles(dir: string): Promise<number> {
	return (await listMdFiles(dir)).length;
}

async function dirExists(path: string): Promise<boolean> {
	try { await access(path, constants.F_OK); return true; } catch { return false; }
}

function slugify(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

export function teamosApi(opts: ApiOptions): Plugin {
	const { teamDir, siblingDir } = opts;
	const siblingPort = opts.siblingPort ?? 3004;
	let ticketsDir = opts.ticketsDir ?? null;
	let ticketsAvailable: boolean | null = null;

	async function hasTickets(): Promise<boolean> {
		if (ticketsAvailable !== null) return ticketsAvailable;
		ticketsAvailable = ticketsDir ? await dirExists(ticketsDir) : false;
		return ticketsAvailable;
	}

	async function getMemberSummaries() {
		const manifest = await readJson(join(teamDir, 'members.json'), { members: [] });
		return Promise.all(manifest.members.map(async (m: Record<string, unknown>) => {
			const dir = join(teamDir, 'members', m.name as string);
			const inboxCount = await countMdFiles(join(dir, 'inbox'));
			const todos = await readJson(join(dir, 'todo.json'), { items: [] });
			const items: any[] = todos.items ?? [];
			const schedule = await readJson(join(dir, 'schedule.json'), { events: [] });
			return {
				...m,
				inboxCount,
				todoCount: items.length,
				blockedCount: items.filter((t: any) => t.status === 'blocked').length,
				eventCount: (schedule.events ?? []).length,
			};
		}));
	}

	async function getMemberDetail(name: string) {
		const dir = join(teamDir, 'members', name);
		const profileRaw = await readText(join(dir, 'profile.md'));
		const state = await readText(join(dir, 'state.md'));
		const todos = await readJson(join(dir, 'todo.json'), { items: [] });
		const schedule = await readJson(join(dir, 'schedule.json'), { events: [] });
		return { name, profile: parseFrontmatter(profileRaw), state, todos, schedule };
	}

	async function getInbox(name: string) {
		const dir = join(teamDir, 'members', name, 'inbox');
		const files = await listMdFiles(dir);
		return Promise.all(files.map(async filename => {
			const content = await readFile(join(dir, filename), 'utf-8');
			const { meta, body } = parseFrontmatter(content);
			return { filename, ...meta, body };
		}));
	}

	async function getArchives(name: string) {
		const dir = join(teamDir, 'members', name, 'archives');
		const files = await listMdFiles(dir);
		return Promise.all(files.map(async filename => {
			const content = await readFile(join(dir, filename), 'utf-8');
			const { meta, body } = parseFrontmatter(content);
			return { filename, ...meta, body };
		}));
	}

	async function sendMessage(recipientName: string, msg: { from: string; requestResponse?: boolean; projectCode?: string; subject?: string; body: string }) {
		const inboxDir = join(teamDir, 'members', recipientName, 'inbox');
		await mkdir(inboxDir, { recursive: true });
		const slug = msg.subject ? slugify(msg.subject) : Date.now().toString();
		const filename = `message-${slugify(msg.from)}-${slug}.md`;
		const now = new Date().toISOString();
		let frontmatter = `---\nfrom: ${msg.from}\nsentAt: ${now}\nrequestResponse: ${msg.requestResponse ?? false}`;
		if (msg.projectCode) frontmatter += `\nprojectCode: ${msg.projectCode}`;
		frontmatter += `\n---\n\n`;
		await writeFile(join(inboxDir, filename), frontmatter + msg.body, 'utf-8');
		return { filename, sentAt: now };
	}

	async function deleteInboxMessage(name: string, filename: string) {
		await unlink(join(teamDir, 'members', name, 'inbox', filename));
	}

	async function archiveInboxMessage(name: string, filename: string) {
		const inboxPath = join(teamDir, 'members', name, 'inbox', filename);
		const archivesDir = join(teamDir, 'members', name, 'archives');
		await mkdir(archivesDir, { recursive: true });
		const content = await readFile(inboxPath, 'utf-8');
		let archiveName = filename;
		try {
			await access(join(archivesDir, archiveName), constants.F_OK);
			const stamp = Date.now().toString(36);
			const ext = archiveName.endsWith('.md') ? '.md' : '';
			const base = ext ? archiveName.slice(0, -ext.length) : archiveName;
			archiveName = `${base}-${stamp}${ext}`;
		} catch { /* no collision */ }
		await writeFile(join(archivesDir, archiveName), content, 'utf-8');
		await unlink(inboxPath);
		return { archivedAs: archiveName };
	}

	async function deleteArchiveMessage(name: string, filename: string) {
		await unlink(join(teamDir, 'members', name, 'archives', filename));
	}

	async function createMemo(memo: { title: string; content: string; importance: string; authorName: string; projectCodes?: string[]; expiresAt?: string }) {
		const memosPath = join(teamDir, 'memos.json');
		const data = await readJson(memosPath, { items: [] });
		const items: any[] = data.items ?? [];
		const newMemo = {
			title: memo.title,
			content: memo.content,
			postedAt: new Date().toISOString(),
			...(memo.expiresAt ? { expiresAt: memo.expiresAt } : {}),
			importance: memo.importance,
			authorName: memo.authorName,
			...(memo.projectCodes?.length ? { projectCodes: memo.projectCodes } : {}),
		};
		items.push(newMemo);
		data.items = items;
		await writeFile(memosPath, JSON.stringify(data, null, '\t'), 'utf-8');
		return newMemo;
	}

	async function archiveMemo(index: number) {
		const memosPath = join(teamDir, 'memos.json');
		const data = await readJson(memosPath, { items: [] });
		const items: any[] = data.items ?? [];
		if (index < 0 || index >= items.length) throw new Error('Invalid memo index');
		const [memo] = items.splice(index, 1);
		await writeFile(memosPath, JSON.stringify(data, null, '\t'), 'utf-8');
		const archivesDir = join(teamDir, 'archives');
		await mkdir(archivesDir, { recursive: true });
		const slug = memo.title ? slugify(memo.title) : Date.now().toString();
		let filename = `memo-${slug}.json`;
		try {
			await access(join(archivesDir, filename), constants.F_OK);
			filename = `memo-${slug}-${Date.now().toString(36)}.json`;
		} catch { /* no collision */ }
		await writeFile(join(archivesDir, filename), JSON.stringify(memo, null, '\t'), 'utf-8');
		return { archivedAs: filename };
	}

	async function stopCycle(): Promise<{ ok: boolean }> {
		const stopFile = join(teamDir, '.stop');
		await writeFile(stopFile, '', 'utf-8');
		return { ok: true };
	}

	async function isStopPending(): Promise<boolean> {
		return dirExists(join(teamDir, '.stop'));
	}

	async function getSibling(): Promise<{ name: string; url: string } | null> {
		if (!siblingDir || !await dirExists(siblingDir)) return null;
		return { name: 'tess', url: `http://localhost:${siblingPort}` };
	}

	async function getTicketSummary(): Promise<Record<string, number> | null> {
		if (!await hasTickets() || !ticketsDir) return null;
		const stages = ['fix', 'plan', 'implement', 'review', 'blocked', 'complete'];
		const counts: Record<string, number> = {};
		for (const stage of stages) {
			counts[stage] = await countMdFiles(join(ticketsDir, stage));
		}
		return counts;
	}

	return {
		name: 'teamos-api',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				if (!req.url?.startsWith('/api/')) return next();

				const url = new URL(req.url, `http://${req.headers.host}`);
				const path = url.pathname;
				const method = req.method?.toUpperCase() ?? 'GET';

				try {
					if (path === '/api/members' && method === 'GET') {
						return json(res, await getMemberSummaries());
					}

					if (path === '/api/memos' && method === 'GET') {
						return json(res, await readJson(join(teamDir, 'memos.json'), { items: [] }));
					}

					if (path === '/api/memos' && method === 'POST') {
						const memo = JSON.parse(await readBody(req));
						return json(res, await createMemo(memo), 201);
					}

					if (path.match(/^\/api\/memos\/(\d+)\/archive$/) && method === 'POST') {
						const idx = parseInt(path.match(/^\/api\/memos\/(\d+)\/archive$/)![1], 10);
						return json(res, await archiveMemo(idx));
					}

					if (path === '/api/projects' && method === 'GET') {
						return json(res, await readJson(join(teamDir, 'projects.json'), { projects: [] }));
					}

					if (path === '/api/tickets' && method === 'GET') {
						return json(res, await getTicketSummary());
					}

					if (path === '/api/sibling' && method === 'GET') {
						return json(res, await getSibling());
					}

					if (path === '/api/cycle/stop' && method === 'POST') {
						return json(res, await stopCycle());
					}

					if (path === '/api/cycle/status' && method === 'GET') {
						return json(res, { stopPending: await isStopPending() });
					}

					if (path.match(/^\/api\/members\/([^/]+)\/inbox\/([^/]+)$/) && method === 'GET') {
						const m = path.match(/^\/api\/members\/([^/]+)\/inbox\/([^/]+)$/);
						if (m) {
							const mName = decodeURIComponent(m[1]);
							const filename = decodeURIComponent(m[2]);
							const filePath = join(teamDir, 'members', mName, 'inbox', filename);
							const content = await readText(filePath);
							if (!content) return json(res, { error: 'Not found' }, 404);
							const { meta, body: msgBody } = parseFrontmatter(content);
							return json(res, { filename, ...meta, body: msgBody });
						}
					}

					let match = path.match(/^\/api\/members\/([^/]+)$/);
					if (match && method === 'GET') {
						return json(res, await getMemberDetail(decodeURIComponent(match[1])));
					}

					match = path.match(/^\/api\/members\/([^/]+)\/inbox$/);
					if (match) {
						const name = decodeURIComponent(match[1]);
						if (method === 'GET') return json(res, await getInbox(name));
						if (method === 'POST') {
							const msg = JSON.parse(await readBody(req));
							return json(res, await sendMessage(name, msg), 201);
						}
					}

					match = path.match(/^\/api\/members\/([^/]+)\/inbox\/([^/]+)\/archive$/);
					if (match && method === 'POST') {
						const name = decodeURIComponent(match[1]);
						const filename = decodeURIComponent(match[2]);
						return json(res, await archiveInboxMessage(name, filename));
					}

					match = path.match(/^\/api\/members\/([^/]+)\/inbox\/([^/]+)$/);
					if (match && method === 'DELETE') {
						const name = decodeURIComponent(match[1]);
						const filename = decodeURIComponent(match[2]);
						await deleteInboxMessage(name, filename);
						return json(res, { ok: true });
					}

					match = path.match(/^\/api\/members\/([^/]+)\/archives$/);
					if (match && method === 'GET') {
						return json(res, await getArchives(decodeURIComponent(match[1])));
					}

					match = path.match(/^\/api\/members\/([^/]+)\/archives\/([^/]+)$/);
					if (match && method === 'DELETE') {
						const name = decodeURIComponent(match[1]);
						const filename = decodeURIComponent(match[2]);
						await deleteArchiveMessage(name, filename);
						return json(res, { ok: true });
					}

					match = path.match(/^\/api\/members\/([^/]+)\/todos$/);
					if (match) {
						const name = decodeURIComponent(match[1]);
						const todosPath = join(teamDir, 'members', name, 'todo.json');
						if (method === 'GET') return json(res, await readJson(todosPath, { items: [] }));
						if (method === 'PUT') {
							const data = JSON.parse(await readBody(req));
							await writeFile(todosPath, JSON.stringify(data, null, '\t'), 'utf-8');
							return json(res, { ok: true });
						}
					}

				match = path.match(/^\/api\/members\/([^/]+)\/state$/);
				if (match && method === 'PUT') {
					const name = decodeURIComponent(match[1]);
					const { state } = JSON.parse(await readBody(req));
					await writeFile(join(teamDir, 'members', name, 'state.md'), state, 'utf-8');
					return json(res, { ok: true });
				}

				match = path.match(/^\/api\/members\/([^/]+)\/schedule$/);
				if (match) {
						const name = decodeURIComponent(match[1]);
						const schedulePath = join(teamDir, 'members', name, 'schedule.json');
						if (method === 'GET') return json(res, await readJson(schedulePath, { events: [] }));
						if (method === 'PUT') {
							const data = JSON.parse(await readBody(req));
							await writeFile(schedulePath, JSON.stringify(data, null, '\t'), 'utf-8');
							return json(res, { ok: true });
						}
					}

					json(res, { error: 'Not found' }, 404);
				} catch (err: any) {
					console.error('[teamos-api]', err);
					json(res, { error: err.message }, 500);
				}
			});
		},
	};
}
