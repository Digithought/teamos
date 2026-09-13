<script lang="ts">
import { tick, untrack } from 'svelte';
import { api } from '../lib/api.js';
import { router } from '../lib/router.svelte.js';
import type { MailBox, MailboxCounts, Thread, ThreadMessage } from '../lib/types.js';

const {
	name,
	oncounts,
}: {
	name: string;
	oncounts?: (counts: MailboxCounts) => void;
} = $props();

type Filter = MailBox | 'all';

let threads = $state<Thread[]>([]);
let loading = $state(true);
let filter = $state<Filter>('inbox');
let search = $state('');
let selectedId = $state<string | null>(null);
let expanded = $state<Set<string>>(new Set());
let bodies = $state<Record<string, string>>({});
let bodiesLoading = $state(false);
let busy = $state<string | null>(null);
/** Set while a deep link (?msg=) is waiting for its thread to render. */
let scrollTarget = $state<string | null>(null);
let paneEl = $state<HTMLDivElement | null>(null);

// Chip counts are conversations, not messages — they label rows the filter shows.
const counts = $derived<MailboxCounts>({
	inbox: threads.filter((t) => t.inboxCount > 0).length,
	sent: threads.filter((t) => t.sentCount > 0).length,
	archives: threads.filter((t) => t.archiveCount > 0).length,
	all: threads.length,
	inboxMessages: threads.reduce((n, t) => n + t.inboxCount, 0),
});

$effect(() => {
	oncounts?.(counts);
});

function matchesFilter(t: Thread, f: Filter): boolean {
	if (f === 'all') return true;
	if (f === 'inbox') return t.inboxCount > 0;
	if (f === 'sent') return t.sentCount > 0;
	return t.archiveCount > 0;
}

function matchesSearch(t: Thread, q: string): boolean {
	if (!q) return true;
	const needle = q.toLowerCase();
	return (
		t.subject.toLowerCase().includes(needle) ||
		t.preview.toLowerCase().includes(needle) ||
		t.participants.some((p) => p.toLowerCase().includes(needle)) ||
		t.projectCodes.some((p) => p.toLowerCase().includes(needle))
	);
}

const visible = $derived(threads.filter((t) => matchesFilter(t, filter) && matchesSearch(t, search)));
const selected = $derived(threads.find((t) => t.id === selectedId) ?? null);

/**
 * Chronological order hides structure when a subject spawned more than one
 * chain, so messages render depth-first from each root instead: a reply always
 * sits directly under the message it answers.
 */
function treeOrder(msgs: ThreadMessage[]): ThreadMessage[] {
	const byId = new Map(msgs.map((m) => [m.id, m]));
	const children = new Map<string, ThreadMessage[]>();
	const roots: ThreadMessage[] = [];
	for (const m of msgs) {
		if (m.replyTo && byId.has(m.replyTo)) {
			const kids = children.get(m.replyTo);
			if (kids) kids.push(m);
			else children.set(m.replyTo, [m]);
		} else {
			roots.push(m);
		}
	}
	const byTime = (a: ThreadMessage, b: ThreadMessage) => (a.sentAt || '').localeCompare(b.sentAt || '');
	const out: ThreadMessage[] = [];
	const walk = (m: ThreadMessage) => {
		out.push(m);
		for (const child of (children.get(m.id) ?? []).sort(byTime)) walk(child);
	};
	for (const root of roots.sort(byTime)) walk(root);
	return out;
}

const orderedMessages = $derived(selected ? treeOrder(selected.messages) : []);

async function load(keepSelection = true) {
	loading = threads.length === 0;
	const fresh = await api.threads(name);
	threads = fresh;
	loading = false;
	if (!keepSelection || !fresh.some((t) => t.id === selectedId)) {
		selectedId = null;
	}
	// Landing on an empty Inbox when there is history to read is a dead end, so
	// the first load of a member falls back to All. A filter the user picked is
	// never overridden.
	if (!keepSelection && filter === 'inbox' && fresh.length > 0 && !fresh.some((t) => t.inboxCount > 0)) {
		filter = 'all';
	}
	const deepLink = router.query.msg;
	if (deepLink) {
		const owner = fresh.find((t) => t.messages.some((m) => m.id === deepLink));
		if (owner) {
			if (!matchesFilter(owner, filter)) filter = 'all';
			await openThread(owner, [deepLink]);
			scrollTarget = deepLink;
		}
	}
	if (!selectedId) {
		const first = fresh.find((t) => matchesFilter(t, filter) && matchesSearch(t, search));
		if (first) await openThread(first);
	}
}

$effect(() => {
	// Only the member identity re-runs this. `load` reads `threads` before its
	// first await, and tracking that read would make its own write re-enter the
	// effect — a reload loop that re-opens the thread and throws the reading
	// pane's scroll position back to the top mid-scroll.
	name;
	untrack(() => load(false));
});

$effect(() => {
	if (!scrollTarget || bodiesLoading) return;
	const id = scrollTarget;
	scrollTarget = null;
	tick().then(() => document.getElementById(`msg-${id}`)?.scrollIntoView({ block: 'start' }));
});

/** How many unhandled inbox messages open on their own before the thread is folded instead. */
const AUTO_EXPAND_LIMIT = 5;

/**
 * The newest message opens, and so does unhandled inbox mail — but only while
 * there is little enough of it to still read as a thread. A long-running
 * conversation with two dozen unread replies opens folded, one line each.
 */
function defaultExpanded(thread: Thread, extra: string[] = []): Set<string> {
	const open = new Set<string>(extra);
	const unhandled = thread.messages.filter((m) => m.boxes.includes('inbox'));
	if (unhandled.length <= AUTO_EXPAND_LIMIT) {
		for (const m of unhandled) open.add(m.id);
	}
	const ordered = treeOrder(thread.messages);
	const last = ordered[ordered.length - 1];
	if (last) open.add(last.id);
	return open;
}

async function openThread(thread: Thread, alsoExpand: string[] = []) {
	selectedId = thread.id;
	expanded = defaultExpanded(thread, alsoExpand);
	if (paneEl) paneEl.scrollTop = 0;
	await loadBodies(thread);
}

async function loadBodies(thread: Thread) {
	const missing = thread.messages.map((m) => m.id).filter((id) => bodies[id] === undefined);
	if (missing.length === 0) return;
	bodiesLoading = true;
	try {
		const msgs = await api.messagesBatch(missing);
		const next = { ...bodies };
		for (const m of msgs) next[m.id] = m.body;
		// Ids the store no longer resolves get an explicit marker so the row
		// doesn't sit on "Loading..." forever.
		for (const id of missing) if (next[id] === undefined) next[id] = '(message no longer in the store)';
		bodies = next;
	} finally {
		bodiesLoading = false;
	}
}

function toggleMessage(id: string) {
	const next = new Set(expanded);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	expanded = next;
}

function expandAll() {
	expanded = new Set(orderedMessages.map((m) => m.id));
}

function collapseAll() {
	expanded = new Set();
}

async function archiveMessage(id: string) {
	busy = id;
	try {
		await api.archiveMessage(name, id);
		await load();
	} finally {
		busy = null;
	}
}

async function unarchiveMessage(id: string) {
	busy = id;
	try {
		await api.unarchiveMessage(name, id);
		await load();
	} finally {
		busy = null;
	}
}

async function deleteMessage(msg: ThreadMessage) {
	busy = msg.id;
	try {
		if (msg.boxes.includes('inbox')) await api.deleteMessage(name, msg.id);
		if (msg.boxes.includes('archives')) await api.deleteArchive(name, msg.id);
		await load();
	} finally {
		busy = null;
	}
}

async function archiveThread(thread: Thread) {
	const ids = thread.messages.filter((m) => m.boxes.includes('inbox')).map((m) => m.id);
	if (ids.length === 0) return;
	busy = thread.id;
	try {
		for (const id of ids) await api.archiveMessage(name, id);
		await load();
	} finally {
		busy = null;
	}
}

function replyHref(msg: ThreadMessage, all = false): string {
	const qs = `re=${encodeURIComponent(msg.id)}&inbox=${encodeURIComponent(name)}${all ? '&all=1' : ''}`;
	return `#/compose?${qs}`;
}

function relTime(iso: string): string {
	if (!iso) return '';
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return '';
	const mins = Math.round((Date.now() - then) / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fullTime(iso: string): string {
	return iso ? new Date(iso).toLocaleString() : '';
}

/** "Rex, Val, Sage +2" — the header line has room for three names. */
function participantLabel(people: string[]): string {
	const shown = people.slice(0, 3).join(', ');
	return people.length > 3 ? `${shown} +${people.length - 3}` : shown;
}

function normalize(subject: string): string {
	return (subject ?? '').replace(/^(\s*re:\s*)+/i, '').trim();
}

/**
 * A reply that renamed the subject mid-thread — "Registry rev 5 — ..." under
 * "Our two vocabularies collide" — is the one thing a collapsed row must still
 * say, or the rename is invisible until you open every message.
 */
function subjectDrift(msg: ThreadMessage, thread: Thread): string {
	const own = normalize(msg.subject);
	return own && own !== normalize(thread.subject) ? own : '';
}

function snippetOf(id: string): string {
	const body = bodies[id];
	if (body === undefined) return '';
	return body.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function roleOf(msg: ThreadMessage): string {
	if (msg.from === name) return 'you sent';
	if (msg.to.includes(name)) return 'to you';
	if (msg.cc?.includes(name)) return 'cc you';
	return 'context';
}
</script>

<div class="toolbar">
	<div class="filters" role="tablist" aria-label="Mailbox">
		{#each [['inbox', 'Inbox', counts.inbox], ['sent', 'Sent', counts.sent], ['archives', 'Archived', counts.archives], ['all', 'All', counts.all]] as const as [key, label, n]}
			<button
				class="filter"
				class:active={filter === key}
				role="tab"
				aria-selected={filter === key}
				onclick={() => (filter = key as Filter)}
			>
				{label}
				<span class="filter-count">{n}</span>
			</button>
		{/each}
	</div>
	<input class="search" type="search" placeholder="Search subject, people, text..." bind:value={search} />
</div>

{#if loading}
	<div class="empty">Loading messages...</div>
{:else}
	<div class="panes">
		<div class="thread-list">
			{#if visible.length === 0}
				<div class="empty small">{search ? 'Nothing matches that search' : 'Nothing here'}</div>
			{:else}
				{#each visible as thread (thread.id)}
					<button
						class="thread-row"
						class:selected={thread.id === selectedId}
						class:unhandled={thread.inboxCount > 0}
						onclick={() => openThread(thread)}
					>
						<div class="row-top">
							<span class="row-subject">{thread.subject}</span>
							<span class="row-time">{relTime(thread.lastAt)}</span>
						</div>
						<div class="row-people">
							{participantLabel(thread.participants)}
							{#if thread.messageCount > 1}
								<span class="row-count">{thread.messageCount}</span>
							{/if}
							{#if thread.inboxCount > 0}
								<span class="row-badge inbox">{thread.inboxCount} in inbox</span>
							{/if}
							{#each thread.projectCodes as code}
								<span class="row-badge project">{code}</span>
							{/each}
						</div>
						<div class="row-preview">{thread.preview}</div>
					</button>
				{/each}
			{/if}
		</div>

		<div class="thread-pane" bind:this={paneEl}>
			{#if !selected}
				<div class="empty">Select a conversation</div>
			{:else}
				<div class="pane-header">
					<h2 class="pane-subject">{selected.subject}</h2>
					<div class="pane-meta">
						<span>{selected.messageCount} message{selected.messageCount === 1 ? '' : 's'}</span>
						<span>·</span>
						<span>{selected.participants.join(', ')}</span>
						{#each selected.projectCodes as code}
							<span class="row-badge project">{code}</span>
						{/each}
					</div>
					<div class="pane-actions">
						{#if selected.inboxCount > 0}
							<button
								class="action-btn archive"
								disabled={busy === selected.id}
								onclick={() => archiveThread(selected)}
							>
								Archive thread ({selected.inboxCount})
							</button>
						{/if}
						<button class="action-btn plain" onclick={expandAll}>Expand all</button>
						<button class="action-btn plain" onclick={collapseAll}>Collapse all</button>
					</div>
				</div>

				<div class="messages">
					{#each orderedMessages as msg (msg.id)}
						{@const isOpen = expanded.has(msg.id)}
						<div
							class="message"
							id="msg-{msg.id}"
							class:open={isOpen}
							class:context={msg.boxes.length === 0}
							class:superseded={!!msg.supersededBy}
							style:margin-left="{Math.min(msg.depth, 6) * 0.75}rem"
						>
							<button class="msg-head" onclick={() => toggleMessage(msg.id)}>
								<span class="msg-toggle">{isOpen ? '▾' : '▸'}</span>
								<span class="msg-from">{msg.from}</span>
								<span class="msg-role" class:mine={msg.from === name}>{roleOf(msg)}</span>
								{#if msg.boxes.includes('inbox')}
									<span class="row-badge inbox">inbox</span>
								{/if}
								{#if msg.supersededBy}
									<span class="row-badge muted">superseded</span>
								{/if}
								{#if msg.supersedes?.length}
									<span class="row-badge warn">consolidates {msg.supersedes.length}</span>
								{/if}
								{#if !isOpen}
									{@const drift = subjectDrift(msg, selected)}
									<span class="msg-gist" class:renamed={!!drift}>{drift || snippetOf(msg.id)}</span>
								{/if}
								<span class="msg-time" title={fullTime(msg.sentAt)}>{relTime(msg.sentAt)}</span>
							</button>
							{#if isOpen}
								<div class="msg-body">
									<div class="msg-recipients">
										<span>To: {msg.to.join(', ') || '—'}</span>
										{#if msg.cc?.length}<span>Cc: {msg.cc.join(', ')}</span>{/if}
										<span class="msg-full-time">{fullTime(msg.sentAt)}</span>
									</div>
									{#if bodies[msg.id] === undefined}
										<div class="empty small">Loading...</div>
									{:else}
										<pre class="msg-text">{bodies[msg.id]}</pre>
									{/if}
									<div class="msg-actions">
										<a class="action-btn reply" href={replyHref(msg)}>Reply</a>
										{#if msg.to.length + (msg.cc?.length ?? 0) > 1}
											<a class="action-btn reply" href={replyHref(msg, true)}>Reply All</a>
										{/if}
										{#if msg.boxes.includes('inbox')}
											<button
												class="action-btn archive"
												disabled={busy === msg.id}
												onclick={() => archiveMessage(msg.id)}
											>
												Archive
											</button>
										{/if}
										{#if msg.boxes.includes('archives')}
											<button
												class="action-btn archive"
												disabled={busy === msg.id}
												onclick={() => unarchiveMessage(msg.id)}
											>
												Unarchive
											</button>
										{/if}
										{#if msg.boxes.some((b) => b === 'inbox' || b === 'archives')}
											<button
												class="action-btn delete"
												disabled={busy === msg.id}
												onclick={() => deleteMessage(msg)}
											>
												Delete
											</button>
										{/if}
									</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.toolbar {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}
	.filters {
		display: flex;
		gap: 0.25rem;
		background: var(--bg);
		padding: 0.2rem;
		border-radius: var(--radius);
	}
	.filter {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3rem 0.7rem;
		border-radius: var(--radius);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-muted);
		transition: all var(--transition);
	}
	.filter:hover { color: var(--text); }
	.filter.active { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
	.filter-count {
		font-size: 0.7rem;
		font-weight: 700;
		padding: 0.02rem 0.35rem;
		border-radius: 99px;
		background: var(--border);
		color: var(--text-muted);
	}
	.filter.active .filter-count { background: var(--primary-subtle); color: var(--primary); }
	.search {
		flex: 1;
		min-width: 200px;
		padding: 0.4rem 0.7rem;
		font-size: 0.85rem;
		background: var(--bg);
	}

	.panes {
		display: grid;
		grid-template-columns: minmax(240px, 340px) 1fr;
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 900px) {
		.panes { grid-template-columns: 1fr; }
		.thread-list { max-height: 320px; }
	}

	.thread-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-height: calc(100vh - 320px);
		min-height: 200px;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.25rem;
		background: var(--bg);
	}
	.thread-row {
		display: block;
		width: 100%;
		text-align: left;
		padding: 0.5rem 0.6rem;
		border-radius: var(--radius);
		border-left: 3px solid transparent;
		transition: background var(--transition);
	}
	.thread-row:hover { background: var(--surface-raised); }
	.thread-row.selected { background: var(--surface); border-left-color: var(--primary); box-shadow: var(--shadow); }
	.thread-row.unhandled .row-subject { font-weight: 700; color: var(--text); }
	.row-top { display: flex; align-items: baseline; gap: 0.5rem; }
	.row-subject {
		flex: 1;
		min-width: 0;
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.thread-row.selected .row-subject { color: var(--text); }
	.row-time { font-size: 0.7rem; color: var(--text-light); flex-shrink: 0; }
	.row-people {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-wrap: wrap;
		font-size: 0.72rem;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.row-count {
		font-size: 0.65rem;
		font-weight: 700;
		padding: 0.02rem 0.35rem;
		border-radius: 99px;
		border: 1px solid var(--border);
		color: var(--text-light);
	}
	.row-badge {
		font-size: 0.65rem;
		font-weight: 700;
		padding: 0.02rem 0.4rem;
		border-radius: 99px;
	}
	.row-badge.inbox { background: var(--primary-subtle); color: var(--primary); }
	.row-badge.project { background: var(--ai-subtle); color: var(--ai); }
	.row-badge.warn { background: var(--warning-subtle); color: var(--warning); }
	.row-badge.muted {
		background: var(--bg);
		color: var(--text-light);
		border: 1px dashed var(--border);
		text-decoration: line-through;
	}
	.row-preview {
		font-size: 0.72rem;
		color: var(--text-light);
		margin-top: 0.15rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.thread-pane {
		max-height: calc(100vh - 320px);
		min-height: 200px;
		overflow-y: auto;
		padding-right: 0.25rem;
	}
	.pane-header {
		position: sticky;
		top: 0;
		background: var(--surface);
		padding-bottom: 0.6rem;
		border-bottom: 1px solid var(--border);
		margin-bottom: 0.6rem;
		z-index: 1;
	}
	.pane-subject { font-size: 1.05rem; font-weight: 700; line-height: 1.35; }
	.pane-meta {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		flex-wrap: wrap;
		font-size: 0.75rem;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.pane-actions { display: flex; gap: 0.4rem; margin-top: 0.5rem; flex-wrap: wrap; }

	.messages { display: flex; flex-direction: column; gap: 0.375rem; }
	.message {
		/* Clears the sticky thread header when a deep link scrolls a message into view. */
		scroll-margin-top: 6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		overflow: hidden;
	}
	.message.open { border-color: var(--text-light); }
	.message.context { opacity: 0.65; border-style: dashed; }
	.message.superseded .msg-from { text-decoration: line-through; }
	.msg-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		text-align: left;
		padding: 0.45rem 0.7rem;
		font-size: 0.82rem;
		transition: background var(--transition);
	}
	.msg-head:hover { background: var(--surface-raised); }
	.msg-toggle { color: var(--text-light); width: 0.8rem; flex-shrink: 0; }
	.msg-from { font-weight: 700; }
	.msg-role { font-size: 0.68rem; color: var(--text-light); text-transform: uppercase; letter-spacing: 0.04em; }
	.msg-role.mine { color: var(--human); }
	.msg-gist {
		flex: 1;
		min-width: 0;
		font-size: 0.75rem;
		color: var(--text-light);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.msg-gist.renamed { color: var(--text-muted); font-style: italic; }
	.msg-time { margin-left: auto; font-size: 0.72rem; color: var(--text-light); flex-shrink: 0; }
	.msg-body { padding: 0 0.7rem 0.7rem; border-top: 1px solid var(--border); }
	.msg-recipients {
		display: flex;
		gap: 0.75rem;
		flex-wrap: wrap;
		font-size: 0.72rem;
		color: var(--text-muted);
		padding: 0.5rem 0 0.25rem;
	}
	.msg-full-time { margin-left: auto; }
	.msg-text {
		font-family: var(--font);
		font-size: 0.85rem;
		line-height: 1.6;
		white-space: pre-wrap;
		word-wrap: break-word;
		padding: 0.4rem 0 0.6rem;
	}
	.msg-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
	.action-btn {
		padding: 0.3rem 0.6rem;
		border-radius: var(--radius);
		font-size: 0.75rem;
		font-weight: 600;
		transition: all var(--transition);
		text-decoration: none;
	}
	.action-btn:disabled { opacity: 0.5; cursor: default; }
	.action-btn.reply { background: var(--primary-subtle); color: var(--primary); }
	.action-btn.reply:hover { background: var(--primary); color: var(--on-primary); text-decoration: none; }
	.action-btn.archive { background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); }
	.action-btn.archive:hover { color: var(--text); }
	.action-btn.plain { color: var(--text-muted); border: 1px solid transparent; }
	.action-btn.plain:hover { border-color: var(--border); color: var(--text); }
	.action-btn.delete { color: var(--danger); }
	.action-btn.delete:hover { background: var(--danger-subtle); }

	.empty { text-align: center; padding: 2rem; color: var(--text-muted); font-style: italic; }
	.empty.small { padding: 1rem; font-size: 0.8rem; }
</style>
