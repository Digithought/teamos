import type { MemberSummary, MemberDetail, InboxMessage, Memo, Project, TicketCounts, SiblingInfo } from './types.js';

async function get<T>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return res.json();
}

async function post<T>(url: string, body: unknown): Promise<T> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return res.json();
}

async function put(url: string, body: unknown): Promise<void> {
	const res = await fetch(url, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

async function del(url: string): Promise<void> {
	const res = await fetch(url, { method: 'DELETE' });
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export const api = {
	members: () => get<MemberSummary[]>('/api/members'),
	member: (name: string) => get<MemberDetail>(`/api/members/${encodeURIComponent(name)}`),
	inbox: (name: string) => get<InboxMessage[]>(`/api/members/${encodeURIComponent(name)}/inbox`),
	archives: (name: string) => get<InboxMessage[]>(`/api/members/${encodeURIComponent(name)}/archives`),
	sendMessage: (to: string, msg: { from: string; requestResponse?: boolean; projectCode?: string; subject?: string; body: string }) =>
		post<{ filename: string; sentAt: string }>(`/api/members/${encodeURIComponent(to)}/inbox`, msg),
	deleteMessage: (member: string, filename: string) =>
		del(`/api/members/${encodeURIComponent(member)}/inbox/${encodeURIComponent(filename)}`),
	archiveMessage: (member: string, filename: string) =>
		post<{ archivedAs: string }>(`/api/members/${encodeURIComponent(member)}/inbox/${encodeURIComponent(filename)}/archive`, {}),
	deleteArchive: (member: string, filename: string) =>
		del(`/api/members/${encodeURIComponent(member)}/archives/${encodeURIComponent(filename)}`),
	todos: (name: string) => get<{ items: unknown[] }>(`/api/members/${encodeURIComponent(name)}/todos`),
	updateTodos: (name: string, data: { items: unknown[] }) =>
		put(`/api/members/${encodeURIComponent(name)}/todos`, data),
	updateState: (name: string, state: string) =>
		put(`/api/members/${encodeURIComponent(name)}/state`, { state }),
	schedule: (name: string) => get<{ events: unknown[] }>(`/api/members/${encodeURIComponent(name)}/schedule`),
	updateSchedule: (name: string, data: { events: unknown[] }) =>
		put(`/api/members/${encodeURIComponent(name)}/schedule`, data),
	memos: () => get<{ items: Memo[] }>('/api/memos'),
	createMemo: (memo: { title: string; content: string; importance: string; authorName: string; projectCodes?: string[]; expiresAt?: string }) =>
		post<Memo>('/api/memos', memo),
	archiveMemo: (index: number) =>
		post<{ archivedAs: string }>(`/api/memos/${index}/archive`, {}),
	projects: () => get<{ projects: Project[] }>('/api/projects'),
	tickets: () => get<TicketCounts | null>('/api/tickets'),
	sibling: () => get<SiblingInfo | null>('/api/sibling'),
	cycleStop: () => post<{ ok: boolean }>('/api/cycle/stop', {}),
	cycleStatus: () => get<{ stopPending: boolean }>('/api/cycle/status'),
	inboxMessage: (member: string, filename: string) =>
		get<InboxMessage>(`/api/members/${encodeURIComponent(member)}/inbox/${encodeURIComponent(filename)}`),
};
