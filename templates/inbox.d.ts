/**
 * TeamOS messaging shapes.
 *
 * These are the shapes the messaging MCP tools return. Send, read, and
 * manage messages via `send_message`, `supersede_message`, `read_message`,
 * `list_inbox`, `list_sent`, `list_archives`, `archive_message`,
 * `unarchive_message`. There is no supported way to access messages outside
 * those tools.
 */

/**
 * What a message to a human member wants from them.
 *
 * A new thread (no `replyTo`) with a human in `to`/`cc` must carry one; a
 * reply needs none. Messages from before this rule have none and read as
 * untagged.
 *   - `decide` — exactly one standalone question, with `default` and
 *     `defaultBy`. Silence means the default goes ahead.
 *   - `fyi` — nothing needed. Filed to the human's archives and their FYI
 *     digest, never their inbox.
 */
export type Ask = 'decide' | 'fyi';

/** Ask fields a sender may set on `send_message` (and, minus `resolves`, `supersede_message`). */
export interface AskArgs {
	ask?: Ask;
	/** decide only, required: one line saying what happens if there is no answer. */
	default?: string;
	/** decide only, required: ISO date after which the default goes ahead. A bare date runs to the end of that day, UTC. */
	defaultBy?: string;
	/**
	 * Id of a decide YOU sent whose `defaultBy` has passed unanswered: this
	 * message reports the default was applied and closes it. Threads under the
	 * question; filed to the human's archives.
	 */
	resolves?: string;
}

/** Ask state on a stored message. `resolvedBy` / `resolvedAt` / `resolution` are written by the adapter. */
export interface AskState extends AskArgs {
	/** decide: the message that closed it — the human's reply, or the sender's `resolves`. */
	resolvedBy?: string;
	resolvedAt?: string;
	resolution?: 'answered' | 'default-applied';
}

/**
 * A full message as returned by `read_message(id)`.
 *
 * TeamOS messages behave like email: a message has `from`, `to`, `cc`,
 * `subject`, `body`, and an optional `replyTo` back-pointer that forms
 * a thread. `to` and `cc` deliver identically; the distinction is only
 * how the recipient perceives their involvement.
 */
export interface Message extends AskState {
	id: string; // opaque — never parse or construct
	from: string; // sender member name
	to: string[]; // primary recipients
	cc?: string[]; // optional cc'd recipients
	subject: string; // required on new threads; replies auto-derive `Re: <parent>`
	sentAt: string; // ISO-8601
	replyTo?: string; // id of the immediately preceding message in the thread
	/** Ids of prior messages this one consolidates / replaces (set by `supersede_message`). */
	supersedes?: string[];
	/** Id of a later message that consolidates / replaces this one (written by the adapter). */
	supersededBy?: string;
	projectCode?: string; // optional project tag
	body: string; // markdown

	/**
	 * When `replyTo` is set, `read_message` inlines the immediate parent
	 * one hop deep. To walk further back, call `read_message(parent.replyTo)`.
	 */
	parent?: Message;
}

/**
 * What `list_inbox` / `list_sent` / `list_archives` return — summaries
 * only, newest first. `hasParent` is true when `replyTo` is set, so a
 * caller can show "this is part of a thread" without fetching the body.
 * `supersedes` / `supersededBy` surface consolidation links so the UI
 * or agent can mark consolidated messages without fetching the body.
 *
 * Inbox/archives listings collapse a predecessor when its consolidated
 * version is reachable in the same mailbox; sent listings do not collapse.
 */
export interface MessageSummary extends Omit<AskState, 'resolvedAt'> {
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

/**
 * Arguments to `send_message`. Returns `{ id, sentAt }`.
 */
export interface SendMessageArgs extends AskArgs {
	to: string[];
	body: string;
	subject?: string; // required on new threads; optional on replies
	cc?: string[];
	replyTo?: string;
	projectCode?: string;
}

/**
 * Arguments to `supersede_message`. The new message replaces one or more
 * earlier messages YOU sent. The new `to`+`cc` must cover every recipient
 * any predecessor reached.
 *
 * Returns `{ id, sentAt, supersededIds, unreadRemoved, alreadyDelivered }`.
 *   - `unreadRemoved` — predecessor copies pulled from recipient inboxes.
 *   - `alreadyDelivered` — recipients who had already moved the predecessor
 *     out of their inbox (typically archived); they receive the new message
 *     normally and can re-read.
 */
export interface SupersedeMessageArgs extends Omit<AskArgs, 'resolves'> {
	supersedes: string[];
	to: string[];
	body: string;
	subject?: string;
	cc?: string[];
	replyTo?: string;
	projectCode?: string;
}
