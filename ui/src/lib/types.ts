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

export type MailBox = 'inbox' | 'sent' | 'archives';

/** One message inside a thread group. No body — bodies load when the thread opens. */
export interface ThreadMessage {
	id: string;
	from: string;
	to: string[];
	cc?: string[];
	subject: string;
	sentAt: string;
	replyTo?: string;
	projectCode?: string;
	supersedes?: string[];
	supersededBy?: string;
	/** Which of the viewed member's mailboxes hold this id. Empty = ancestor shown for context. */
	boxes: MailBox[];
	/** Reply distance from the root of its own chain, for indentation. */
	depth: number;
}

/** Messages sharing a subject, with their reply chains resolved through the master store. */
export interface Thread {
	id: string;
	subject: string;
	participants: string[];
	projectCodes: string[];
	messageCount: number;
	inboxCount: number;
	sentCount: number;
	archiveCount: number;
	firstAt: string;
	lastAt: string;
	lastFrom: string;
	preview: string;
	messages: ThreadMessage[];
}

/** Thread counts per mailbox filter, plus the raw inbox message count for the tab badge. */
export interface MailboxCounts {
	inbox: number;
	sent: number;
	archives: number;
	all: number;
	inboxMessages: number;
}

/** One thing said in a chat session, by the human or by the member. */
export interface ChatTranscriptEntry {
	role: 'human' | 'member';
	text: string;
	at: string;
}

export interface ChatSession {
	id: string;
	member: string;
	human: string;
	startedAt: string;
	lastActiveAt: string;
	/** True while a turn's agent is still running. */
	busy: boolean;
	transcript: ChatTranscriptEntry[];
}

/** Whether a scheduled cycle is in flight for the member, and any open chat. */
export interface ChatStatus {
	midCycle: boolean;
	since?: string;
	session: ChatSession | null;
}

/** One stream event from a chat turn. `text` is the member speaking. */
export interface ChatEvent {
	kind: 'text' | 'tool' | 'thinking' | 'result' | 'done' | 'error';
	content?: string;
	detail?: string;
	message?: string;
	exitCode?: number;
	answer?: string;
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
