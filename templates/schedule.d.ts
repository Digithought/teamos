/**
 * A scheduled event.
 *
 * Canonical shape per teamos/docs/schedule.md. Agents interact with these
 * exclusively through the MCP tools `list_events`, `add_event`, `update_event`,
 * `remove_event` — never by writing `schedule.json` directly.
 */
export interface ScheduleEvent {
	/** Adapter-allocated, opaque id. Agents treat it as a string — never parse or construct. */
	id: string;
	/** One-line summary */
	title: string;
	/** Longer body — what to do when this fires, links to rules, etc. */
	description?: string;
	/** ISO-8601 timestamp of the next occurrence. The adapter keeps this fresh for recurring events. */
	time: string;
	/**
	 * Recurrence descriptor. Absence means one-time. Agents never advance
	 * recurring events — the runner does that automatically in acknowledgeDue.
	 */
	recurrence?: {
		frequency: 'daily' | 'weekly' | 'monthly';
		interval: number;
		/** Optional ISO-8601 cutoff; the event is removed after this point. */
		endDate?: string;
	};
	/** Optional project tag for filtering/grouping */
	projectCode?: string;
}

/** Root structure for schedule.json */
export interface Schedule {
	events: ScheduleEvent[];
}
