/**
 * Types for the member Logs tab, and the reader that turns a log's plain text
 * back into something structured enough to style.
 *
 * The text is what `formatClaudeJsonLine` (scripts/lib/agents/claude.mjs)
 * wrote: a header, `[session …]`, `[ASSISTANT]` / `[USER]` blocks,
 * `[TOOL:Name] {json}` lines, `  > result` lines, runs of `.` for thinking
 * heartbeats, `[RESULT DONE | 12.3s | cost $0.12]` and `[runner] …` lines,
 * plus any stream-json line it didn't recognise, passed through raw.
 */

export type LogStatus = 'running' | 'ok' | 'failed' | 'interrupted';

export interface LogEntry {
	name: string;
	kind: 'cycle' | 'chat';
	/** Cycle priority; null for a chat. */
	priority: string | null;
	startedAt: string;
	updatedAt: string;
	size: number;
	running: boolean;
	status: LogStatus;
	/** Last `[runner] Agent exited with code N`; null if the run never finished. */
	exitCode: number | null;
	/** Agent time from the `[RESULT]` lines, or wall clock while running. */
	durationSec: number | null;
	/** Sum of every `[RESULT]` cost in the log (a chat has one per turn). */
	costUsd: number | null;
	/** How many agent runs the log holds (a cycle resumed for leftovers has two). */
	runs: number;
}

export interface LogChunk {
	name: string;
	kind: 'cycle' | 'chat';
	size: number;
	/** Byte range of `text` within the file. Pass `to` back as the next `from` to follow. */
	from: number;
	to: number;
	text: string;
	running: boolean;
	exitCode: number | null;
	status: LogStatus;
}

export type LogBlockKind =
	| 'header'
	| 'session'
	| 'assistant'
	| 'user'
	| 'tool'
	| 'output'
	| 'thinking'
	| 'final'
	| 'runner'
	| 'raw'
	| 'text';

export interface LogBlock {
	kind: LogBlockKind;
	/** Tool name for `tool`, status line for `final`. */
	label?: string;
	text: string;
	/** Heartbeat count for `thinking`. */
	count?: number;
	/** `final` with ERROR, or `runner` reporting a non-zero exit or a kill. */
	bad?: boolean;
}

const RULE = /^═{8,}$/;
const DOTS = /^(\.+)(.*)$/;
const TOOL = /^\[TOOL:([^\]]+)\] ?(.*)$/;
const FINAL = /^\[RESULT (DONE|ERROR)([^\]]*)\]$/;

/** Split log text into styled blocks. Consecutive heartbeat runs fold into one. */
export function parseLog(text: string, { fromStart }: { fromStart: boolean }): LogBlock[] {
	const blocks: LogBlock[] = [];
	// The header is only recognisable when the text starts at byte 0, and only
	// cycle and clerk logs have one (it ends at a rule of '═').
	let inHeader = fromStart && /^═{8,}$/m.test(text.slice(0, 4096));
	// The block later lines continue; a holder so TS doesn't narrow it across the closures.
	const at: { cur: LogBlock | null } = { cur: null };

	const push = (block: LogBlock) => {
		if (block.kind === 'thinking' && at.cur?.kind === 'thinking') {
			at.cur.count = (at.cur.count ?? 0) + (block.count ?? 0);
			return;
		}
		blocks.push(block);
		at.cur = block;
	};
	const append = (line: string) => {
		const cur = at.cur;
		if (cur && ['header', 'assistant', 'user', 'output', 'final', 'text'].includes(cur.kind)) {
			cur.text += cur.text ? `\n${line}` : line;
		} else if (line.trim() !== '') {
			push({ kind: 'text', text: line });
		}
	};

	for (let line of text.split('\n')) {
		if (inHeader) {
			if (RULE.test(line)) {
				inHeader = false;
				at.cur = null;
				continue;
			}
			if (at.cur) at.cur.text += `\n${line}`;
			else push({ kind: 'header', text: line });
			continue;
		}
		const dots = DOTS.exec(line);
		if (dots) {
			push({ kind: 'thinking', text: '', count: dots[1].length });
			line = dots[2];
			if (line === '') continue;
		}
		if (line === '[ASSISTANT]') {
			push({ kind: 'assistant', text: '' });
			continue;
		}
		if (line === '[USER]') {
			push({ kind: 'user', text: '' });
			continue;
		}
		if (line.startsWith('[session ')) {
			push({ kind: 'session', text: line });
			continue;
		}
		const tool = TOOL.exec(line);
		if (tool) {
			push({ kind: 'tool', label: tool[1], text: tool[2] });
			continue;
		}
		const final = FINAL.exec(line);
		if (final) {
			push({ kind: 'final', label: `${final[1]}${final[2]}`, text: '', bad: final[1] === 'ERROR' });
			continue;
		}
		if (line.startsWith('[runner] ')) {
			const exit = /exited with code (-?\d+)/.exec(line);
			push({ kind: 'runner', text: line, bad: exit ? exit[1] !== '0' : /kill|idle/i.test(line) });
			at.cur = null;
			continue;
		}
		// Results follow tool calls; inside prose a "  > " is just an indented quote.
		const k = at.cur?.kind;
		if (line.startsWith('  > ') && k !== 'assistant' && k !== 'user' && k !== 'final') {
			push({ kind: 'output', text: line.slice(4) });
			continue;
		}
		if (line.startsWith('{"type":')) {
			push({ kind: 'raw', text: line });
			continue;
		}
		append(line);
	}

	for (const b of blocks) b.text = b.text.replace(/^\n+|\s+$/g, '');
	return blocks.filter((b) => b.text !== '' || b.kind === 'thinking' || b.kind === 'final');
}

export function formatDuration(sec: number | null): string {
	if (sec === null) return '—';
	if (sec < 60) return `${Math.round(sec)}s`;
	const m = Math.floor(sec / 60);
	if (m < 60) return `${m}m ${Math.round(sec % 60)}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatCost(usd: number | null): string {
	return usd === null ? '—' : `$${usd.toFixed(2)}`;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
