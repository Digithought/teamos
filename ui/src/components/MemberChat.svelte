<script lang="ts">
import { tick } from 'svelte';
import { ApiError, api } from '../lib/api.js';
import { identity } from '../lib/identity.svelte.js';
import type { ChatGone, ChatSession, ChatStatus, ChatTranscriptEntry } from '../lib/types.js';

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
/**
 * Set when this tab's chat ended under it: swept, ended in another tab, or lost. `session`
 * and the transcript stay as they were, so the conversation stays on screen and can be
 * continued.
 */
let gone = $state<ChatGone | null>(null);
/** The draft is a message that failed to send because the chat had gone; Continue sends it. */
let resend = $state(false);
/** A different chat with this member, open elsewhere, while this tab's has gone. */
let otherOpen = $state<ChatSession | null>(null);

const canChat = $derived(!!identity.name);
const breaks = $derived(session?.breaks ?? []);

function adopt(next: ChatSession) {
	session = next;
	transcript = next.transcript;
	seenCompletions = next.cycleCompletions.length;
	gone = null;
	otherOpen = null;
}

async function loadStatus() {
	try {
		// Naming the tab's chat makes this poll its heartbeat: the server
		// ends only chats no tab is polling (or that have sat quiet for hours).
		status = await api.chatStatus(name, session?.id);
		if (session && status.gone) {
			// Ended under this tab. Keep the conversation and say what happened.
			gone = status.gone;
			otherOpen = status.session;
			return;
		}
		// A session opened in another tab (or left behind by a reload) is the
		// same conversation — adopt it rather than offering a second chat the
		// server would reject.
		if (status.session && !session) adopt(status.session);
		// A cycle that finished between polls: the turn stream would have
		// carried it, but only if a turn happened to be running.
		const completions = status.session?.cycleCompletions.length ?? 0;
		if (completions > seenCompletions) {
			seenCompletions = completions;
			noteCycleFinished();
		}
	} catch {
		/* the status poll is advisory — a failed poll (a restarting dashboard) shouldn't break the pane */
	}
}

$effect(() => {
	name;
	loadStatus();
	const timer = setInterval(loadStatus, 15000);
	// A tab coming back to the front catches up at once rather than on the next tick.
	const onVisible = () => {
		if (document.visibilityState === 'visible') loadStatus();
	};
	document.addEventListener('visibilitychange', onVisible);
	return () => {
		clearInterval(timer);
		document.removeEventListener('visibilitychange', onVisible);
	};
});

function minutes(n: number): string {
	if (n < 60) return `${n} minute${n === 1 ? '' : 's'}`;
	const h = Math.floor(n / 60);
	const m = n % 60;
	return `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} min` : ''}`;
}

/** One plain line on what happened to the chat, from what the server knows. */
function goneText(g: ChatGone): string {
	if (g.reason === 'unknown') {
		return `This chat is no longer open, and the dashboard has no record of it (it may have been lost in a restart). Nothing from it has been wrapped up.`;
	}
	let what: string;
	if (g.reason === 'idle' && g.idle?.kind === 'unwatched') {
		what = `This chat ended after ${minutes(g.idle.minutes)} idle with no dashboard tab open on it`;
	} else if (g.reason === 'idle') {
		what = `This chat ended after ${minutes(g.idle?.minutes ?? 0)} with no messages`;
	} else if (g.reason === 'discarded') {
		return 'This chat was discarded from another tab; nothing from it was recorded.';
	} else {
		what = 'This chat was ended from another tab';
	}
	const wrap =
		g.wrapUp === 'running'
			? `${name} is wrapping it up`
			: g.wrapUp === 'done'
				? `${name} wrapped it up`
				: g.wrapUp === 'failed'
					? `${name}'s wrap-up failed (see the chat log)`
					: g.wrapUp === 'interrupted'
						? `${name}'s wrap-up was cut off by a dashboard restart and may not have finished`
						: '';
	const archived = g.messageId ? `the transcript was archived as ${g.messageId}` : '';
	const tail = [wrap, archived].filter(Boolean).join(' and ');
	return `${what}${tail ? `; ${tail}` : ''}.`;
}

/** The chat ended before `text` could be sent: take it back out of the pane and into the composer. */
function returnUnsent(text: string, info: ChatGone) {
	const last = transcript.at(-1);
	if (last?.role === 'human' && last.text === text) transcript = transcript.slice(0, -1);
	draft = draft.trim() ? `${text}\n\n${draft}` : text;
	resend = true;
	gone = info;
	error = null;
}

/**
 * Carry the conversation on in a new chat. The server seeds it with the earlier transcript
 * (from its record, or from this tab's copy if it has none) and marks where it resumed, so
 * the member picks up the thread and records only what is new when this one ends.
 */
async function continueChat(send_ = resend) {
	if (!gone || !identity.name) return;
	starting = true;
	error = null;
	try {
		const next = await api.startChat(name, identity.name, { continueFrom: gone.id, transcript });
		adopt(next);
		cycleNote = null;
		filed = null;
		const again = send_ && !!draft.trim();
		resend = false;
		if (again) await send();
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		// Someone opened a new chat meanwhile: the notice offers that one instead.
		if (err instanceof ApiError && err.status === 409) await loadStatus();
	} finally {
		starting = false;
	}
}

/** Leave the ended chat behind: back to the start button. */
function closeGone() {
	gone = null;
	resend = false;
	otherOpen = null;
	session = null;
	transcript = [];
	void loadStatus();
}

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
	if (gone) return continueChat(true);
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
			} else if (event.kind === 'error' && event.gone) {
				returnUnsent(text, event.gone);
			} else if (event.kind === 'error') {
				error = event.message ?? 'The chat turn failed.';
			} else if (event.kind === 'done') {
				const answer = (event.answer ?? streaming).trim();
				if (answer) transcript = [...transcript, { role: 'member', text: answer, at: new Date().toISOString() }];
				if (!answer && !error) error = `${name} ended the turn without saying anything (exit ${event.exitCode}).`;
			}
		}
	} catch (err) {
		// An abort is the human pressing Stop; a chat that ended under us gets the
		// message back in the composer and a Continue; anything else is worth showing.
		if (err instanceof ApiError && err.gone) returnUnsent(text, err.gone);
		else if (!controller.signal.aborted) error = err instanceof Error ? err.message : String(err);
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
		// Already ended elsewhere: say how, and keep the conversation.
		if (err instanceof ApiError && err.gone) {
			gone = err.gone;
			return;
		}
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

	{#if !session && !gone}
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
	{:else if gone}
		<div class="gone" role="status">
			<span class="gone-text">
				{goneText(gone)}
				{#if otherOpen}
					Another chat with {name} is open now (started {new Date(otherOpen.startedAt).toLocaleTimeString()}).
				{:else}
					Continue starts a new chat carrying this conversation, so {name} picks up where you left off{resend
						? ', and sends your unsent message'
						: ''}.
				{/if}
			</span>
			<span class="gone-actions">
				{#if otherOpen}
					<button class="add-btn" onclick={() => otherOpen && adopt(otherOpen)}>Open that chat</button>
				{:else}
					<button class="add-btn" onclick={() => continueChat()} disabled={starting || !canChat}>
						{starting ? 'Continuing...' : resend ? 'Continue & send' : 'Continue'}
					</button>
				{/if}
				<button class="end-btn" onclick={closeGone} disabled={starting}>Close</button>
			</span>
		</div>
	{:else if session}
		<div class="session-bar">
			<span class="session-meta">
				Chatting as <strong>{session.human}</strong> since {new Date(session.startedAt).toLocaleTimeString()}
			</span>
			<button class="end-btn" onclick={() => end(true)} disabled={sending}>End chat</button>
			<button class="discard-btn" onclick={() => end(false)} disabled={sending}>Discard</button>
		</div>
	{/if}

	{#if session}
		<div class="pane" bind:this={paneEl}>
			{#if transcript.length === 0 && !streaming}
				<div class="empty">Say something to {name}</div>
			{/if}
			{#each transcript as entry, i (i)}
				{#each breaks.filter((b) => b.index === i) as b (b.at)}
					{@render resumed(b)}
				{/each}
				<div class="turn" class:member={entry.role === 'member'}>
					<div class="turn-who">{entry.role === 'human' ? session.human : name}</div>
					<pre class="turn-text">{entry.text}</pre>
				</div>
			{/each}
			{#each breaks.filter((b) => b.index >= transcript.length && transcript.length > 0) as b (b.at)}
				{@render resumed(b)}
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
				disabled={sending || starting}
			></textarea>
			{#if sending}
				<button class="cancel-btn" onclick={stop}>Stop</button>
			{:else if gone && otherOpen}
				<!-- The draft is kept; it goes to whichever chat the human opens. -->
				<button class="add-btn" disabled>Send</button>
			{:else}
				<button class="add-btn" onclick={send} disabled={!draft.trim() || starting || (!!gone && !canChat)}>
					{gone ? 'Continue & send' : 'Send'}
				</button>
			{/if}
		</div>
	{/if}
</div>

{#snippet resumed(b: { at: string; wrappedUp: boolean })}
	<div class="resumed">
		Continued {new Date(b.at).toLocaleString()} —
		{b.wrappedUp
			? `${name} had already wrapped up everything above`
			: `nothing above had been wrapped up yet; ${name} records it when this chat ends`}
	</div>
{/snippet}

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
	.gone {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		font-size: 0.8rem;
		line-height: 1.6;
		color: var(--text);
		background: var(--warning-subtle);
		border: 1px solid var(--warning);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem;
	}
	.gone-text { flex: 1; min-width: 16rem; }
	.gone-actions { display: flex; gap: 0.5rem; }
	.resumed {
		font-size: 0.75rem;
		color: var(--text-light);
		font-style: italic;
		text-align: center;
		border-top: 1px dashed var(--border);
		padding-top: 0.5rem;
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
