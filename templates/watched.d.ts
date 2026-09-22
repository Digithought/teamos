/**
 * A watch subscription — wakes the member when a named probe's result changes.
 *
 * Canonical shape per teamos/docs/watches.md. Agents interact with these
 * exclusively through the MCP tools `list_watches`, `add_watch`,
 * `remove_watch` — never by writing `watched.json` directly. A watch carries
 * no command: probes are registered by humans under `probes` in
 * teamos.config.json and referenced here by name.
 */
export interface Watch {
	/** Adapter-allocated, opaque id. Agents treat it as a string — never parse or construct. */
	id: string;
	/** Name of a probe registered in teamos.config.json. Unknown names are rejected at mutation time. */
	probe: string;
	/** Priority at which a transition wakes the member. */
	priority: 'pressing' | 'today' | 'thisWeek' | 'later';
	/**
	 * Hit semantics. `nonEmptyOutput` (default): the probe printed something.
	 * `exitCode`: the probe exited with `exitCode`. `outputChanged`: any change
	 * in the probe's output is a transition.
	 */
	fires: 'nonEmptyOutput' | 'exitCode' | 'outputChanged';
	/** The exit code that counts as a hit (with `fires: 'exitCode'`). Defaults to 0. */
	exitCode?: number;
	/** Parameters the probe declares. Every declared name is required; others are rejected. */
	params?: Record<string, string>;
	/** Short note on why the subscription exists. Surfaces in list_watches. */
	reason?: string;
	/** Minimum minutes between wakes from this watch. Defaults to 15; 0 disables. */
	cooldownMinutes: number;
}

/** One probe run, as recorded by the runner. */
export interface WatchObservationRecord {
	status: 'hit' | 'clear' | 'changed' | 'error';
	/** What the edge detector diffs — two runs with the same signature are the same observation. */
	signature: string;
	observedAt: string;
	exitCode: number | null;
	/** stdout (or stderr when stdout was empty), clipped. */
	output: string;
	/** Set when the probe could not be executed at all. */
	error?: string;
}

/** Per-watch observation state. Managed by the runner — agents should not edit this. */
export interface WatchState {
	/** The signature the member has been woken through. Advances only after a successful cycle. */
	signature: string;
	status: 'hit' | 'clear' | 'changed' | 'error';
	/** When the acknowledged state was first observed. */
	since: string;
	/** When this watch last woke the member — the cooldown runs from here. */
	lastFiredAt?: string;
	latest: WatchObservationRecord;
}

/** Root structure for watched.json */
export interface Watches {
	items: Watch[];
	observed: Record<string, WatchState>;
}
