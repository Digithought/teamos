/**
 * TeamOS messaging shapes.
 *
 * These are the shapes the messaging MCP tools return. Send, read, and
 * manage messages via `send_message`, `read_message`, `list_inbox`,
 * `list_sent`, `list_archives`, `archive_message`, `unarchive_message`.
 * There is no supported way to access messages outside those tools.
 */

/**
 * A full message as returned by `read_message(id)`.
 *
 * TeamOS messages behave like email: a message has `from`, `to`, `cc`,
 * `subject`, `body`, and an optional `replyTo` back-pointer that forms
 * a thread. `to` and `cc` deliver identically; the distinction is only
 * how the recipient perceives their involvement.
 */
export interface Message {
  id: string;            // opaque — never parse or construct
  from: string;          // sender member name
  to: string[];          // primary recipients
  cc?: string[];         // optional cc'd recipients
  subject: string;       // required on new threads; replies auto-derive `Re: <parent>`
  sentAt: string;        // ISO-8601
  replyTo?: string;      // id of the immediately preceding message in the thread
  projectCode?: string;  // optional project tag
  body: string;          // markdown

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
 */
export interface MessageSummary {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  sentAt: string;
  projectCode?: string;
  hasParent: boolean;
}

/**
 * Arguments to `send_message`. Returns `{ id, sentAt }`.
 */
export interface SendMessageArgs {
  to: string[];
  body: string;
  subject?: string;      // required on new threads; optional on replies
  cc?: string[];
  replyTo?: string;
  projectCode?: string;
}
