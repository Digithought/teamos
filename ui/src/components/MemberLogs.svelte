<script lang="ts">
import { tick } from 'svelte';
import { api } from '../lib/api.js';
import { formatCost, formatDuration, formatSize, parseLog, type LogChunk, type LogEntry } from '../lib/logs.js';

const { name }: { name: string } = $props();

/** How much of a log opens at first, and how much each "earlier" click adds. */
const TAIL_BYTES = 128 * 1024;
const EARLIER_BYTES = 256 * 1024;
/** Following a running log: a tail read this often is plenty for a human reading along. */
const FOLLOW_MS = 3000;
const LIST_MS = 15000;

let entries = $state<LogEntry[]>([]);
let listLoading = $state(true);
let listError = $state<string | null>(null);

let selected = $state<string | null>(null);
/** The loaded window of the selected log: bytes [from, to) of a file `size` long. */
let view = $state<{ text: string; from: number; to: number; size: number; running: boolean; status: LogChunk['status'] } | null>(
	null,
);
let viewLoading = $state(false);
let viewError = $state<string | null>(null);
let loadingEarlier = $state(false);
let paneEl = $state<HTMLDivElement | null>(null);

const blocks = $derived(view ? parseLog(view.text, { fromStart: view.from === 0 }) : []);
const selectedEntry = $derived(entries.find((e) => e.name === selected) ?? null);

async function loadList() {
	try {
		entries = await api.logs(name);
		listError = null;
	} catch (err) {
		listError = err instanceof Error ? err.message : 'Failed to load logs';
	} finally {
		listLoading = false;
	}
}

$effect(() => {
	name;
	selected = null;
	view = null;
	listLoading = true;
	loadList();
	const timer = setInterval(loadList, LIST_MS);
	return () => clearInterval(timer);
});

function nearBottom(): boolean {
	if (!paneEl) return true;
	return paneEl.scrollHeight - paneEl.scrollTop - paneEl.clientHeight < 80;
}

async function scrollToEnd() {
	await tick();
	if (paneEl) paneEl.scrollTop = paneEl.scrollHeight;
}

async function openLog(entry: LogEntry) {
	selected = entry.name;
	view = null;
	viewError = null;
	viewLoading = true;
	try {
		const chunk = await api.log(name, entry.name, { tail: TAIL_BYTES });
		if (selected !== entry.name) return;
		view = { ...chunk };
		viewLoading = false;
		await scrollToEnd();
	} catch (err) {
		if (selected === entry.name) viewError = err instanceof Error ? err.message : 'Failed to load log';
	} finally {
		if (selected === entry.name) viewLoading = false;
	}
}

async function loadEarlier() {
	if (!view || view.from === 0 || !selected) return;
	const file = selected;
	loadingEarlier = true;
	try {
		const chunk = await api.log(name, file, { from: Math.max(0, view.from - EARLIER_BYTES), to: view.from });
		if (selected !== file || !view) return;
		// Keep the reader's place: what was on screen stays on screen.
		const fromBottom = paneEl ? paneEl.scrollHeight - paneEl.scrollTop : 0;
		view = { ...view, text: chunk.text + view.text, from: chunk.from };
		await tick();
		if (paneEl) paneEl.scrollTop = paneEl.scrollHeight - fromBottom;
	} catch (err) {
		viewError = err instanceof Error ? err.message : 'Failed to load earlier text';
	} finally {
		loadingEarlier = false;
	}
}

async function follow() {
	if (!view || !selected) return;
	const file = selected;
	try {
		const chunk = await api.log(name, file, { from: view.to });
		if (selected !== file || !view) return;
		const stick = nearBottom();
		const finished = view.running && !chunk.running;
		view = {
			...view,
			text: chunk.text ? view.text + chunk.text : view.text,
			to: chunk.to,
			size: chunk.size,
			running: chunk.running,
			status: chunk.status,
		};
		if (chunk.text && stick) await scrollToEnd();
		if (finished) loadList();
	} catch {
		/* a missed poll is retried on the next tick */
	}
}

// Follow a running log. Derived so the timer re-arms only when `running` flips,
// not on every poll that replaces `view`.
const following = $derived(!!view?.running);
$effect(() => {
	if (!following) return;
	const timer = setInterval(follow, FOLLOW_MS);
	return () => clearInterval(timer);
});

function priorityColor(p: string | null): string {
	const map: Record<string, string> = {
		pressing: 'var(--danger)',
		today: 'var(--warning)',
		thisWeek: 'var(--primary)',
		later: 'var(--text-light)',
	};
	return p ? (map[p] ?? 'var(--text-muted)') : 'var(--human)';
}

function when(iso: string): string {
	const d = new Date(iso);
	const sameDay = d.toDateString() === new Date().toDateString();
	return sameDay
		? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		: d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusText(e: { status: LogChunk['status']; exitCode: number | null }): string {
	if (e.status === 'running') return 'running';
	if (e.status === 'interrupted') return 'no exit';
	return e.exitCode === 0 ? 'exit 0' : `exit ${e.exitCode}`;
}
</script>

<div class="logs">
	<div class="list">
		{#if listLoading}
			<div class="empty">Loading…</div>
		{:else if listError}
			<div class="error">{listError}</div>
		{:else if entries.length === 0}
			<div class="empty">No logs for {name}</div>
		{:else}
			{#each entries as entry (entry.name)}
				<button class="row" class:active={entry.name === selected} onclick={() => openLog(entry)} title={entry.name}>
					<div class="row-top">
						<span class="time">{when(entry.startedAt)}</span>
						<span class="kind" style:color={priorityColor(entry.priority)}>
							{entry.kind === 'chat' ? 'chat' : entry.priority}
						</span>
						<span class="status {entry.status}">{statusText(entry)}</span>
					</div>
					<div class="row-meta">
						<span>{formatDuration(entry.durationSec)}</span>
						<span>{formatCost(entry.costUsd)}</span>
						<span>{formatSize(entry.size)}</span>
						{#if entry.runs > 1}<span title="Runs in this log (a resumed cleanup or chat turns)">×{entry.runs}</span>{/if}
					</div>
				</button>
			{/each}
		{/if}
	</div>

	<div class="viewer">
		{#if !selected}
			<div class="empty">Pick a log to read it</div>
		{:else}
			<div class="viewer-head">
				<span class="file">{selected}</span>
				{#if view}
					<span class="status {view.status}">{view.status === 'running' ? 'following' : view.status}</span>
					<span class="range">
						{view.from > 0 ? `last ${formatSize(view.to - view.from)} of ` : ''}{formatSize(view.size)}
					</span>
				{/if}
				{#if selectedEntry && selectedEntry.costUsd !== null}
					<span class="range">{formatCost(selectedEntry.costUsd)}</span>
				{/if}
			</div>
			{#if viewError}
				<div class="error">{viewError}</div>
			{/if}
			<div class="pane" bind:this={paneEl}>
				{#if viewLoading}
					<div class="empty">Loading…</div>
				{:else if view}
					{#if view.from > 0}
						<button class="earlier" onclick={loadEarlier} disabled={loadingEarlier}>
							{loadingEarlier ? 'Loading…' : `Load earlier (${formatSize(view.from)} more)`}
						</button>
					{/if}
					{#each blocks as block, i (i)}
						{#if block.kind === 'thinking'}
							<div class="b-thinking">· thinking ×{block.count}</div>
						{:else if block.kind === 'assistant'}
							<div class="b-assistant">{block.text}</div>
						{:else if block.kind === 'user'}
							<div class="b-user"><span class="tag">user</span>{block.text}</div>
						{:else if block.kind === 'tool'}
							<div class="b-tool"><span class="tool-name">{block.label}</span> <span class="tool-input">{block.text}</span></div>
						{:else if block.kind === 'output'}
							<div class="b-output">{block.text}</div>
						{:else if block.kind === 'final'}
							<div class="b-final" class:bad={block.bad}>
								<div class="final-label">RESULT {block.label}</div>
								{#if block.text}<div class="final-text">{block.text}</div>{/if}
							</div>
						{:else if block.kind === 'runner'}
							<div class="b-runner" class:bad={block.bad}>{block.text}</div>
						{:else if block.kind === 'header'}
							<div class="b-header">{block.text}</div>
						{:else if block.kind === 'session' || block.kind === 'raw'}
							<div class="b-dim">{block.text}</div>
						{:else}
							<div class="b-text">{block.text}</div>
						{/if}
					{/each}
					{#if view.running}
						<div class="b-live">● still running — following</div>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.logs {
		display: grid;
		grid-template-columns: minmax(240px, 300px) 1fr;
		gap: 1rem;
		min-height: 420px;
	}
	@media (max-width: 800px) {
		.logs { grid-template-columns: 1fr; }
		.list { max-height: 240px; }
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-height: 72vh;
		overflow-y: auto;
		padding-right: 0.25rem;
	}
	.row {
		text-align: left;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		transition: all var(--transition);
	}
	.row:hover { background: var(--bg); }
	.row.active { border-color: var(--primary); background: var(--primary-subtle); }
	.row-top { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; }
	.time { font-weight: 600; }
	.kind { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
	.row-meta {
		display: flex;
		gap: 0.75rem;
		font-size: 0.72rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.status {
		margin-left: auto;
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		padding: 0.04rem 0.4rem;
		border-radius: 99px;
		background: var(--bg);
		color: var(--text-muted);
		white-space: nowrap;
	}
	.status.ok { background: var(--success-subtle); color: var(--success); }
	.status.failed { background: var(--danger-subtle); color: var(--danger); }
	.status.interrupted { background: var(--warning-subtle); color: var(--warning); }
	.status.running { background: var(--primary-subtle); color: var(--primary); animation: pulse 1.6s ease-in-out infinite; }
	@keyframes pulse { 50% { opacity: 0.55; } }

	.viewer { display: flex; flex-direction: column; min-width: 0; }
	.viewer-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
		font-size: 0.78rem;
	}
	.viewer-head .status { margin-left: 0; }
	.file { font-family: var(--font-mono); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.range { color: var(--text-muted); white-space: nowrap; }
	.pane {
		flex: 1;
		max-height: 72vh;
		overflow: auto;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.78rem;
		line-height: 1.5;
	}
	.pane > div { white-space: pre-wrap; word-break: break-word; }
	.earlier {
		display: block;
		margin: 0 auto 0.75rem;
		padding: 0.3rem 0.8rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-muted);
		background: var(--surface);
	}
	.earlier:hover { color: var(--text); }

	.b-header { color: var(--text-muted); margin-bottom: 0.5rem; }
	.b-dim { color: var(--text-light); font-size: 0.7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap !important; }
	.b-thinking { color: var(--text-light); font-size: 0.7rem; font-style: italic; }
	.b-assistant {
		font-family: var(--font);
		font-size: 0.85rem;
		line-height: 1.6;
		color: var(--text);
		background: var(--surface);
		border-left: 3px solid var(--ai);
		border-radius: 0 var(--radius) var(--radius) 0;
		padding: 0.5rem 0.75rem;
		margin: 0.5rem 0;
	}
	.b-user {
		font-family: var(--font);
		font-size: 0.85rem;
		border-left: 3px solid var(--human);
		padding: 0.4rem 0.75rem;
		margin: 0.5rem 0;
	}
	.tag { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; color: var(--human); margin-right: 0.5rem; }
	.b-tool { margin-top: 0.35rem; color: var(--text-muted); }
	.tool-name { color: var(--primary); font-weight: 700; }
	.tool-input { color: var(--text-muted); }
	.b-output {
		color: var(--text-muted);
		opacity: 0.85;
		border-left: 2px solid var(--border);
		padding-left: 0.6rem;
		margin-left: 0.4rem;
		max-height: 14em;
		overflow: auto;
	}
	.b-final {
		margin: 0.75rem 0 0.25rem;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius);
		background: var(--success-subtle);
		border: 1px solid var(--success);
	}
	.b-final.bad { background: var(--danger-subtle); border-color: var(--danger); }
	.final-label { font-weight: 700; color: var(--success); }
	.b-final.bad .final-label { color: var(--danger); }
	.final-text { font-family: var(--font); font-size: 0.85rem; margin-top: 0.25rem; white-space: pre-wrap; }
	.b-runner { font-weight: 700; color: var(--success); margin: 0.25rem 0; }
	.b-runner.bad { color: var(--danger); }
	.b-text { color: var(--text); }
	.b-live { color: var(--primary); font-weight: 600; margin-top: 0.5rem; animation: pulse 1.6s ease-in-out infinite; }

	.empty { text-align: center; padding: 2rem; color: var(--text-muted); font-style: italic; }
	.error {
		font-size: 0.8rem;
		color: var(--danger);
		padding: 0.5rem 0.75rem;
		background: var(--danger-subtle);
		border-radius: var(--radius);
		margin-bottom: 0.5rem;
	}
</style>
