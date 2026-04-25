/**
 * A commit-trigger subscription.
 *
 * Canonical shape per teamos/docs/triggers.md. Agents interact with these
 * exclusively through the MCP tools `list_triggers`, `add_trigger`,
 * `update_trigger`, `remove_trigger` — never by writing `triggers.json`
 * directly.
 */
export interface CommitTrigger {
	/** Adapter-allocated, opaque id. Agents treat it as a string — never parse or construct. */
	id: string;
	/** Priority at which a matching commit wakes the member. */
	priority: 'pressing' | 'today' | 'thisWeek' | 'later';
	/** Short note on why the subscription exists. Surfaces in list_triggers. */
	reason?: string;
	/**
	 * Glob patterns (`**`, `*`, `?`). A commit matches if it touches any file
	 * matching any glob. Omit to match any path.
	 */
	paths?: string[];
	/** Only match commits whose author name or email equals this. */
	author?: string;
	/**
	 * Skip commits by this author. Defaults to the member's own name; set
	 * explicitly (including the empty string) to override.
	 */
	authorNot?: string;
	/** JavaScript regex (string) tested against the commit subject line. */
	messageMatches?: string;
}

/** Root structure for triggers.json */
export interface Triggers {
	/**
	 * Last commit SHA the member has been notified through. Managed by the
	 * runner — agents should not edit this.
	 */
	cursor?: string | null;
	items: CommitTrigger[];
}
