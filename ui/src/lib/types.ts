export interface MemberSummary {
	name: string;
	title: string;
	roles: string[];
	type: 'ai' | 'human';
	active: boolean;
	notes?: string;
	inboxCount: number;
	todoCount: number;
	blockedCount: number;
	eventCount: number;
}

export interface InboxMessage {
	filename: string;
	from: string;
	sentAt: string;
	requestResponse?: boolean;
	projectCode?: string;
	body: string;
}

export interface TodoItem {
	title: string;
	priority: string;
	status?: string;
	notes?: string;
	description?: string;
	projectCode?: string;
}

export interface ScheduleEvent {
	time: string;
	title?: string;
	[key: string]: unknown;
}

export interface MemberDetail {
	name: string;
	profile: { meta: Record<string, unknown>; body: string };
	state: string;
	todos: { items: TodoItem[] };
	schedule: { events: ScheduleEvent[] };
}

export interface Memo {
	title: string;
	content: string;
	postedAt: string;
	expiresAt?: string;
	importance: string;
	authorName: string;
	projectCodes?: string[];
}

export interface Project {
	code: string;
	name: string;
	description: string;
	status: string;
}

export type TicketCounts = Record<string, number>;

export interface SiblingInfo {
	name: string;
	url: string;
}
