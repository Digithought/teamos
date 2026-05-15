import type {
	MemberDetail,
	MemberSummary,
	Memo,
	Message,
	MessageSummary,
	MessagingInfo,
	Project,
	SiblingInfo,
	TicketCounts,
} from './types.js';

async function failure(res: Response): Promise<Error> {
	let detail = '';
	try {
		const data = await res.json();
		if (data && typeof data.error === 'string') detail = data.error;
	} catch {
		try {
			detail = (await res.text()).trim();
		} catch {
			/* ignore */
		}
	}
	return new Error(detail || `${res.status} ${res.statusText}`);
}

async function get<T>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) throw await failure(res);
	return res.json();
}

async function post<T>(url: string, body: unknown): Promise<T> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw await failure(res);
	return res.json();
}

async function put(url: string, body: unknown): Promise<void> {
	const res = await fetch(url, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw await failure(res);
}

async function del(url: string): Promise<void> {
	const res = await fetch(url, { method: 'DELETE' });
	if (!res.ok) throw await failure(res);
}

async function patch(url: string, body: unknown): Promise<void> {
	const res = await fetch(url, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw await failure(res);
}

export interface CreateMemberArgs {
	name: string;
	title?: string;
	description?: string;
	type?: 'ai' | 'human';
	active?: boolean;
	roles?: string[];
	body?: string;
	email?: string;
}

export interface UpdateMemberProfileArgs {
	title?: string;
	description?: string;
	type?: 'ai' | 'human';
	active?: boolean;
	roles?: string[];
	body?: string;
	email?: string | null;
}

export interface MeInfo {
	/** Resolved member name, or null if no header matched and client should use its local selection. */
	name: string | null;
	/** True when the server resolved identity from a trusted proxy header. Clients should treat this as read-only. */
	locked: boolean;
	/** Source header name that matched (only set when locked). */
	source?: string;
	/** Email that was looked up (only set when locked). */
	email?: string;
}

export interface SendMessageArgs {
	from: string;
	to: string[];
	cc?: string[];
	subject?: string;
	body: string;
	replyTo?: string;
	projectCode?: string;
}

export const api = {
	members: () => get<MemberSummary[]>('/api/members'),
	member: (name: string) => get<MemberDetail>(`/api/members/${encodeURIComponent(name)}`),
	createMember: (args: CreateMemberArgs) =>
		post<{ name: string; title: string; roles: string[]; active: boolean; type: string }>('/api/members', args),
	updateMemberProfile: (name: string, patchBody: UpdateMemberProfileArgs) =>
		patch(`/api/members/${encodeURIComponent(name)}/profile`, patchBody),
	deleteMember: (name: string) => del(`/api/members/${encodeURIComponent(name)}`),
	inbox: (name: string) => get<MessageSummary[]>(`/api/members/${encodeURIComponent(name)}/inbox`),
	sent: (name: string) => get<MessageSummary[]>(`/api/members/${encodeURIComponent(name)}/sent`),
	archives: (name: string) => get<MessageSummary[]>(`/api/members/${encodeURIComponent(name)}/archives`),
	message: (id: string) => get<Message>(`/api/messages/${encodeURIComponent(id)}`),
	sendMessage: (msg: SendMessageArgs) => post<{ id: string; sentAt: string }>('/api/messages', msg),
	archiveMessage: (member: string, id: string) =>
		post<{ ok: boolean }>(`/api/members/${encodeURIComponent(member)}/inbox/${encodeURIComponent(id)}/archive`, {}),
	unarchiveMessage: (member: string, id: string) =>
		post<{ ok: boolean }>(
			`/api/members/${encodeURIComponent(member)}/archives/${encodeURIComponent(id)}/unarchive`,
			{},
		),
	deleteMessage: (member: string, id: string) =>
		del(`/api/members/${encodeURIComponent(member)}/inbox/${encodeURIComponent(id)}`),
	deleteArchive: (member: string, id: string) =>
		del(`/api/members/${encodeURIComponent(member)}/archives/${encodeURIComponent(id)}`),
	todos: (name: string) => get<{ items: unknown[] }>(`/api/members/${encodeURIComponent(name)}/todos`),
	updateTodos: (name: string, data: { items: unknown[] }) =>
		put(`/api/members/${encodeURIComponent(name)}/todos`, data),
	updateState: (name: string, state: string) => put(`/api/members/${encodeURIComponent(name)}/state`, { state }),
	schedule: (name: string) => get<{ events: unknown[] }>(`/api/members/${encodeURIComponent(name)}/schedule`),
	addEvent: (
		name: string,
		input: {
			title: string;
			time: string;
			description?: string;
			recurrence?: { frequency: string; interval: number; endDate?: string };
			projectCode?: string;
		},
	) => post<{ id: string }>(`/api/members/${encodeURIComponent(name)}/schedule`, input),
	updateEvent: (
		name: string,
		id: string,
		patchBody: {
			title?: string;
			description?: string;
			time?: string;
			recurrence?: { frequency: string; interval: number; endDate?: string } | null;
			projectCode?: string;
		},
	) => patch(`/api/members/${encodeURIComponent(name)}/schedule/${encodeURIComponent(id)}`, patchBody),
	removeEvent: (name: string, id: string) =>
		del(`/api/members/${encodeURIComponent(name)}/schedule/${encodeURIComponent(id)}`),
	memos: () => get<{ items: Memo[] }>('/api/memos'),
	createMemo: (memo: {
		title: string;
		content: string;
		importance: string;
		authorName: string;
		projectCodes?: string[];
		expiresAt?: string;
	}) => post<Memo>('/api/memos', memo),
	archiveMemo: (index: number) => post<{ archivedAs: string }>(`/api/memos/${index}/archive`, {}),
	projects: () => get<{ projects: Project[] }>('/api/projects'),
	createProject: (input: { code: string; name: string; description?: string; status?: string }) =>
		post<Project>('/api/projects', input),
	updateProject: (code: string, patchBody: { name?: string; description?: string; status?: string }) =>
		patch(`/api/projects/${encodeURIComponent(code)}`, patchBody),
	deleteProject: (code: string) => del(`/api/projects/${encodeURIComponent(code)}`),
	org: () => get<{ content: string }>('/api/org'),
	updateOrg: (content: string) => put('/api/org', { content }),
	tickets: () => get<TicketCounts | null>('/api/tickets'),
	sibling: () => get<SiblingInfo | null>('/api/sibling'),
	cycleStop: () => post<{ ok: boolean }>('/api/cycle/stop', {}),
	cyclePause: () => post<{ ok: boolean }>('/api/cycle/pause', {}),
	cycleResume: () => post<{ ok: boolean }>('/api/cycle/resume', {}),
	cycleStatus: () => get<{ stopPending: boolean; paused: boolean }>('/api/cycle/status'),
	messagingInfo: () => get<MessagingInfo>('/api/messaging/info'),
	me: () => get<MeInfo>('/api/me'),
};
