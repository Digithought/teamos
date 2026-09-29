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
	/**
	 * Where this chat continued an earlier one: a divider before `transcript[index]`.
	 * `wrappedUp` means everything above it is already recorded in the member's state.
	 */
	breaks: { index: number; at: string; wrappedUp: boolean }[];
	/** The chat this one continues, and the archived record it threads onto. */
	continues: { id: string; messageId: string | null; at: string } | null;
	/** Cycles of this member that finished while the chat was open. */
	cycleCompletions: { at: string; exitCode: number }[];
}

/**
 * What happened to a chat that is no longer open. `unknown` means the dashboard has no
 * record of it (older than a day, or lost); the browser's copy of the conversation is then
 * all there is, and continuing seeds the new chat from it.
 */
export interface ChatGone {
	id: string;
	reason: 'idle' | 'ended' | 'discarded' | 'unknown';
	member?: string;
	human?: string;
	endedAt?: string;
	/** Set when the idle sweep ended it: which clock ran out, and minutes since the last turn. */
	idle?: { kind: 'unwatched' | 'quiet'; minutes: number } | null;
	/**
	 * The wrap-up turn: still `running`, `done`, `failed`, `interrupted` (the dashboard restarted
	 * under it), or `none` (nothing new to record).
	 */
	wrapUp?: 'running' | 'done' | 'failed' | 'interrupted' | 'none';
	/** The archived transcript this ending filed, if it filed one. */
	messageId?: string | null;
	turns?: number;
}

/**
 * Whether a scheduled cycle is in flight for the member, and any open chat.
 * `midCycle` is informational only — a chat runs beside a cycle, not after it.
 */
export interface ChatStatus {
	midCycle: boolean;
	since?: string;
	session: ChatSession | null;
	/** Set when the chat the polling tab has open is no longer open. */
	gone: ChatGone | null;
	/** Member files written since the chat opened (mtime), if a chat is open. */
	changedFiles: string[];
}

/** One stream event from a chat turn. `text` is the member speaking. */
export interface ChatEvent {
	/** `cycle` is out-of-band: a scheduled cycle of this member just finished. */
	kind: 'text' | 'tool' | 'thinking' | 'result' | 'done' | 'error' | 'cycle';
	content?: string;
	detail?: string;
	message?: string;
	exitCode?: number;
	answer?: string;
	event?: string;
	at?: string;
	/** On an `error`: the chat ended before the turn could run. */
	gone?: ChatGone;
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
