export interface MemberSummary {
	name: string;
	title: string;
	roles: string[];
	type: 'ai' | 'human';
	active: boolean;
	notes?: string;
	email?: string;
	inboxCount: number;
	todoCount: number;
	blockedCount: number;
	eventCount: number;
}

export interface MessageSummary {
	id: string;
	from: string;
	to: string[];
	cc?: string[];
	subject: string;
	sentAt: string;
	projectCode?: string;
	hasParent: boolean;
	supersedes?: string[];
	supersededBy?: string;
}

export interface Message {
	id: string;
	from: string;
	to: string[];
	cc?: string[];
	subject: string;
	sentAt: string;
	replyTo?: string;
	supersedes?: string[];
	supersededBy?: string;
	projectCode?: string;
	body: string;
	parent?: Message;
}

export interface MessagingInfo {
	adapter: string;
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
	id: string;
	title: string;
	description?: string;
	time: string;
	recurrence?: { frequency: 'daily' | 'weekly' | 'monthly'; interval: number; endDate?: string };
	projectCode?: string;
	isDue?: boolean;
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
