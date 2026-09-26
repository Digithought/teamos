<script lang="ts">
import { tick } from 'svelte';
import { api } from '../lib/api.js';
import { identity } from '../lib/identity.svelte.js';
import type { ChatSession, ChatStatus, ChatTranscriptEntry } from '../lib/types.js';

const { name }: { name: string } = $props();

let status = $state<ChatStatus | null>(null);
let session = $state<ChatSession | null>(null);
let transcript = $state<ChatTranscriptEntry[]>([]);
/** The member's reply as it streams in — promoted into the transcript when the turn ends. */
let streaming = $state('');
let activity = $state('');
let draft = $state('');
let starting = $state(false);
let sending = $state(false);
let error = $state<string | null>(null);
let filed = $state<{ persisted: boolean; messageId?: string; wrappingUp?: boolean } | null>(null);
/** Set when a scheduled cycle of this member finishes while the chat is open. */
let cycleNote = $state<string | null>(null);
let seenCompletions = 0;
let paneEl = $state<HTMLDivElement | null>(null);
let controller: AbortController | null = null;

const canChat = $derived(!!identity.name);

async function loadStatus() {
	try {
		status = await api.chatStatus(name);
		// A session opened in another tab (or left behind by a reload) is the
		// same conversation — adopt it rather than offering a second chat the
		// server would reject.
		if (status.session && !session) {
			session = status.session;
			transcript = status.session.transcript;
			seenCompletions = status.session.cycleCompletions.length;
		}
		// A cycle that finished between polls: the turn stream would have
		// carried it, but only if a turn happened to be running.
		const completions = status.session?.cycleCompletions.length ?? 0;
		if (completions > seenCompletions) {
			seenCompletions = completions;
			noteCycleFinished();
		}
	} catch {
		/* the status poll is advisory — a failed poll shouldn't break the pane */
	}
}

$effect(() => {
	name;
	loadStatus();
	const timer = setInterval(loadStatus, 15000);
	return () => clearInterval(timer);
});

function noteCycleFinished() {
	cycleNote = `${name} just finished a scheduled cycle. Their next reply re-reads whatever it changed.`;
}

async function scrollToEnd() {
	await tick();
	if (paneEl) paneEl.scrollTop = paneEl.scrollHeight;
}

async function start() {
	if (!identity.name) return;
	starting = true;
	error = null;
	filed = null;
	try {
		session = await api.startChat(name, identity.name);
		transcript = session.transcript;
		seenCompletions = session.cycleCompletions.length;
		cycleNote = null;
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		starting = false;
	}
}

async function send() {
	const text = draft.trim();
	if (!session || !text || sending) return;
	sending = true;
	error = null;
	streaming = '';
	activity = '';
	transcript = [...transcript, { role: 'human', text, at: new Date().toISOString() }];
	draft = '';
	await scrollToEnd();

	controller = new AbortController();
	try {
		for await (const event of api.chatTurn(session.id, text, controller.signal)) {
			if (event.kind === 'text' && event.content) {
				streaming += event.content;
				activity = '';
				await scrollToEnd();
			} else if (event.kind === 'tool') {
				activity = `reading — ${event.content}`;
			} else if (event.kind === 'thinking') {
				if (!streaming) activity = 'thinking…';
			} else if (event.kind === 'cycle') {
				// Out-of-band on the turn's stream: the other instance of this
				// member just exited. Nothing to do here — the next turn's
				// prompt carries the list of what it touched.
				seenCompletions += 1;
				noteCycleFinished();
			} else if (event.kind === 'error') {
				error = event.message ?? 'The chat turn failed.';
			} else if (event.kind === 'done') {
				const answer = (event.answer ?? streaming).trim();
				if (answer) transcript = [...transcript, { role: 'member', text: answer, at: new Date().toISOString() }];
				if (!answer && !error) error = `${name} ended the turn without saying anything (exit ${event.exitCode}).`;
			}
		}
	} catch (err) {
		// An abort is the human pressing Stop; anything else is worth showing.
		if (!controller.signal.aborted) error = err instanceof Error ? err.message : String(err);
	} finally {
		streaming = '';
		activity = '';
		controller = null;
		sending = false;
		await scrollToEnd();
	}
}

function stop() {
	controller?.abort();
}

async function end(persist = true) {
	if (!session) return;
	controller?.abort();
	const id = session.id;
	try {
		filed = await api.endChat(id, persist);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}
	session = null;
	transcript = [];
	await loadStatus();
}

function onKeydown(e: KeyboardEvent) {
	if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
}
</script>

<div class="chat">
	<div class="notice">
		<strong>Chat can act.</strong>
		This is a fresh session of {name} with their manifest, state, todos, inbox and full toolset — the same one a cycle
		gets. What you agree on here, they can do here. When you end the chat, {name} wraps up as at the end of a cycle,
		recording decisions and open items in their state and todos, and the transcript is archived as the record.
	</div>

	{#if status?.midCycle}
		<div class="cycle-banner">
			<span class="dot"></span>
			<span>
				FYI: a scheduled cycle of {name} is running{status.since
					? ` (started ${new Date(status.since).toLocaleTimeString()})`
					: ''}. Nothing is waiting on it — this chat and that cycle are two instances of {name} working at the same
				time, and each re-reads before it writes.
			</span>
		</div>
	{/if}

	{#if cycleNote}
		<div class="cycle-note">
			{cycleNote}
			{#if status?.changedFiles?.length}
				Changed since this chat opened: {status.changedFiles.join(', ')}.
			{/if}
			<button class="dismiss" onclick={() => (cycleNote = null)}>Dismiss</button>
		</div>
	{/if}

	{#if filed}
		<div class="filed">
			{#if filed.persisted}
				Chat ended. {name} is wrapping up in the background: recording what was decided into their state and todos.
				The transcript is archived{filed.messageId ? ` as ${filed.messageId}` : ''}.
			{:else if filed.wrappingUp}
				Chat discarded. Nothing is recorded; {name} will revert any edits it left in the checkout.
			{:else}
				Chat ended. Nothing was filed.
			{/if}
		</div>
	{/if}

	{#if !session}
		<div class="start">
			{#if canChat}
				<button class="add-btn" onclick={start} disabled={starting}>
					{starting ? 'Starting...' : `Chat with ${name}`}
				</button>
				<span class="start-hint">Spawns a second instance of {name} — scheduled cycles keep running beside it.</span>
			{:else}
				<span class="start-hint">Pick who you are in the nav bar before starting a chat.</span>
			{/if}
		</div>
	{:else}
		<div class="session-bar">
			<span class="session-meta">
				Chatting as <strong>{session.human}</strong> since {new Date(session.startedAt).toLocaleTimeString()}
			</span>
			<button class="end-btn" onclick={() => end(true)} disabled={sending}>End &amp; file to inbox</button>
			<button class="discard-btn" onclick={() => end(false)} disabled={sending}>Discard</button>
		</div>

		<div class="pane" bind:this={paneEl}>
			{#if transcript.length === 0 && !streaming}
				<div class="empty">Say something to {name}</div>
			{/if}
			{#each transcript as entry, i (i)}
				<div class="turn" class:member={entry.role === 'member'}>
					<div class="turn-who">{entry.role === 'human' ? session.human : name}</div>
					<pre class="turn-text">{entry.text}</pre>
				</div>
			{/each}
			{#if streaming}
				<div class="turn member">
					<div class="turn-who">{name}</div>
					<pre class="turn-text">{streaming}</pre>
				</div>
			{/if}
			{#if activity}
				<div class="activity">{activity}</div>
			{/if}
		</div>

		{#if error}
			<div class="chat-error" role="alert">{error}</div>
		{/if}

		<div class="composer">
			<textarea
				class="composer-input"
				rows="3"
				placeholder={`Message ${name}... (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to send)`}
				bind:value={draft}
				onkeydown={onKeydown}
				disabled={sending}
			></textarea>
			{#if sending}
				<button class="cancel-btn" onclick={stop}>Stop</button>
			{:else}
				<button class="add-btn" onclick={send} disabled={!draft.trim()}>Send</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.chat { display: flex; flex-direction: column; gap: 0.75rem; }
	.notice {
		font-size: 0.8rem;
		line-height: 1.6;
		color: var(--text-muted);
		background: var(--bg);
		border: 1px solid var(--border);
		border-left: 3px solid var(--primary);
		border-radius: var(--radius);
		padding: 0.625rem 0.75rem;
	}
	.notice strong { color: var(--text); }
	.cycle-banner {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		color: var(--warning);
		background: var(--warning-subtle);
		border: 1px solid var(--warning);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem;
	}
	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--warning);
		flex-shrink: 0;
	}
	.cycle-note {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		font-size: 0.8rem;
		color: var(--text-muted);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem;
	}
	.dismiss {
		margin-left: auto;
		font-size: 0.75rem;
		color: var(--text-light);
		text-decoration: underline;
	}
	.filed {
		font-size: 0.8rem;
		color: var(--success);
		background: var(--success-subtle);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem;
	}
	.start { display: flex; align-items: center; gap: 0.75rem; }
	.start-hint { font-size: 0.8rem; color: var(--text-muted); }
	.session-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.session-meta { flex: 1; }
	.pane {
		max-height: 480px;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.empty { text-align: center; padding: 2rem; color: var(--text-muted); font-style: italic; }
	.turn {
		border-left: 3px solid var(--border);
		padding-left: 0.625rem;
	}
	.turn.member { border-left-color: var(--ai); }
	.turn-who {
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		margin-bottom: 0.25rem;
	}
	.turn-text {
		font-family: var(--font);
		font-size: 0.875rem;
		line-height: 1.6;
		white-space: pre-wrap;
		word-wrap: break-word;
		margin: 0;
	}
	.activity { font-size: 0.75rem; color: var(--text-light); font-style: italic; }
	.chat-error {
		font-size: 0.8rem;
		color: var(--danger);
		background: var(--danger-subtle);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem;
	}
	.composer { display: flex; gap: 0.5rem; align-items: flex-end; }
	.composer-input {
		flex: 1;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-family: var(--font);
		font-size: 0.875rem;
		line-height: 1.6;
		background: var(--bg);
		color: var(--text);
		resize: vertical;
	}
	.composer-input:focus { outline: none; border-color: var(--primary); }
	.add-btn {
		padding: 0.5rem 1rem;
		background: var(--primary);
		color: var(--on-primary);
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.875rem;
		transition: background var(--transition);
	}
	.add-btn:hover:not(:disabled) { background: var(--primary-hover); }
	.add-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.cancel-btn, .end-btn, .discard-btn {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.8rem;
		color: var(--text-muted);
		transition: all var(--transition);
	}
	.cancel-btn:hover, .end-btn:hover { background: var(--bg); color: var(--text); }
	.discard-btn { border-color: var(--danger); color: var(--danger); }
	.discard-btn:hover { background: var(--danger); color: var(--on-primary); }
</style>
