<script lang="ts">
	import { api } from '../lib/api.js';
	import { router } from '../lib/router.svelte.js';
	import { identity } from '../lib/identity.svelte.js';
	import type { MemberSummary, Project, Message } from '../lib/types.js';

	let members: MemberSummary[] = $state([]);
	let projects: Project[] = $state([]);
	let loading = $state(true);
	let sending = $state(false);
	let sent = $state(false);

	let to: Set<string> = $state(new Set());
	let cc: Set<string> = $state(new Set());
	let from = $state(identity.name ?? '');
	let subject = $state('');
	let projectCode = $state('');
	let body = $state('');

	let replyMessage: Message | null = $state(null);
	let inboxOwner: string | null = $state(null);

	const isReply = $derived(!!replyMessage);
	const backPath = $derived(inboxOwner ? `/member/${inboxOwner}` : '/');

	$effect(() => {
		if (identity.name && !from) from = identity.name;
	});

	async function load() {
		const [m, p] = await Promise.all([api.members(), api.projects()]);
		members = m;
		projects = p.projects ?? [];

		const re = router.query.re;
		const inbox = router.query.inbox;
		if (re) {
			inboxOwner = inbox ?? null;
			try {
				replyMessage = await api.message(re);
				if (replyMessage.projectCode) projectCode = replyMessage.projectCode;
				to = new Set([replyMessage.from]);
				// Subject auto-derives server-side, but show a preview to the user
				if (!subject) {
					const stripped = (replyMessage.subject ?? '').replace(/^(re:\s*)+/i, '').trim();
					subject = stripped ? `Re: ${stripped}` : '';
				}
			} catch { /* original may have been deleted */ }
		}

		loading = false;
	}

	$effect(() => { load(); });

	function toggle(set: Set<string>, name: string): Set<string> {
		const next = new Set(set);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		return next;
	}

	function toggleTo(name: string) { to = toggle(to, name); }
	function toggleCc(name: string) { cc = toggle(cc, name); }

	function selectAllAI() {
		to = new Set(members.filter(m => m.type === 'ai').map(m => m.name));
	}

	async function send() {
		if (to.size === 0 || !body.trim() || !from.trim()) return;
		sending = true;
		await api.sendMessage({
			from,
			to: [...to],
			cc: cc.size > 0 ? [...cc] : undefined,
			subject: subject || undefined,
			body: body.trim(),
			replyTo: replyMessage?.id,
			projectCode: projectCode || undefined,
		});
		sending = false;
		if (isReply) {
			router.navigate(backPath);
			return;
		}
		sent = true;
	}

	function reset() {
		to = new Set();
		cc = new Set();
		subject = '';
		projectCode = '';
		body = '';
		sent = false;
		replyMessage = null;
		inboxOwner = null;
	}
</script>

<div class="compose">
	<div class="compose-header">
		<button class="back" onclick={() => router.navigate(backPath)}>← Back</button>
		<h1 class="compose-title">{isReply ? 'Reply' : 'Compose Message'}</h1>
	</div>

	{#if sent}
		<div class="sent-confirmation">
			<div class="sent-icon">&#10003;</div>
			<p>Message sent to {[...to].join(', ')}</p>
			<div class="sent-actions">
				<button class="btn btn-primary" onclick={reset}>Compose Another</button>
				<button class="btn btn-ghost" onclick={() => router.navigate(backPath)}>
					{inboxOwner ? `Back to ${inboxOwner}` : 'Back to Dashboard'}
				</button>
			</div>
		</div>
	{:else if loading}
		<div class="loading">Loading...</div>
	{:else}
		<div class="form-group">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="label">To</label>
			<div class="recipients">
				{#each members as member}
					<button
						class="recipient"
						class:selected={to.has(member.name)}
						onclick={() => toggleTo(member.name)}
					>
						{member.name}
						{#if identity.name === member.name}
							<span class="recipient-type">(you)</span>
						{/if}
					</button>
				{/each}
				<button class="recipient select-all" onclick={selectAllAI}>All AI</button>
			</div>
		</div>

		<div class="form-group">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="label">Cc (optional)</label>
			<div class="recipients">
				{#each members as member}
					<button
						class="recipient"
						class:selected={cc.has(member.name)}
						onclick={() => toggleCc(member.name)}
						disabled={to.has(member.name)}
					>
						{member.name}
					</button>
				{/each}
			</div>
		</div>

		<div class="form-row">
			<div class="form-group" style="flex:1">
				<label class="label" for="from">From</label>
				<input id="from" type="text" bind:value={from} placeholder="Your name" />
			</div>
			<div class="form-group" style="flex:2">
				<label class="label" for="subject">
					Subject {isReply ? '(optional — derived from parent)' : ''}
				</label>
				<input id="subject" type="text" bind:value={subject} placeholder="Thread subject" />
			</div>
		</div>

		<div class="form-row">
			<div class="form-group" style="flex:1">
				<label class="label" for="project">Project</label>
				<select id="project" bind:value={projectCode}>
					<option value="">None</option>
					{#each projects as project}
						<option value={project.code}>{project.name} ({project.code})</option>
					{/each}
				</select>
			</div>
		</div>

		{#if replyMessage}
			<div class="reply-context">
				<div class="reply-context-header">
					<span class="reply-label">Replying to</span>
					<span class="reply-from">{replyMessage.from}</span>
					<span class="reply-date">{new Date(replyMessage.sentAt).toLocaleString()}</span>
					{#if replyMessage.subject}
						<span class="reply-subject">{replyMessage.subject}</span>
					{/if}
				</div>
				<pre class="reply-body">{replyMessage.body}</pre>
			</div>
		{/if}

		<div class="form-group">
			<label class="label" for="body">Message</label>
			<textarea id="body" bind:value={body} rows="10" placeholder="Write your message (markdown supported)..."></textarea>
		</div>

		<div class="form-actions">
			<button
				class="btn btn-primary"
				onclick={send}
				disabled={to.size === 0 || !body.trim() || !from.trim() || sending || (!isReply && !subject.trim())}
			>
				{sending ? 'Sending...' : `Send to ${to.size} recipient${to.size !== 1 ? 's' : ''}`}
			</button>
		</div>
	{/if}
</div>

<style>
	.compose { max-width: 720px; }
	.compose-header {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	.back {
		color: var(--text-muted);
		font-size: 0.875rem;
		padding: 0.375rem 0.75rem;
		border-radius: var(--radius);
		transition: all var(--transition);
	}
	.back:hover { background: var(--surface); color: var(--text); }
	.compose-title { font-size: 1.25rem; font-weight: 700; }
	.loading { text-align: center; padding: 3rem; color: var(--text-muted); }

	.form-group { margin-bottom: 1rem; }
	.form-row { display: flex; gap: 1rem; }
	.label {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-muted);
		margin-bottom: 0.375rem;
	}

	.recipients { display: flex; gap: 0.375rem; flex-wrap: wrap; }
	.recipient {
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: 99px;
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--text-muted);
		transition: all var(--transition);
		background: var(--surface);
	}
	.recipient:hover:not(:disabled) { border-color: var(--primary); color: var(--text); }
	.recipient.selected {
		background: var(--primary);
		color: var(--on-primary);
		border-color: var(--primary);
	}
	.recipient:disabled { opacity: 0.4; cursor: not-allowed; }
	.recipient-type { font-size: 0.7rem; opacity: 0.7; }
	.recipient.select-all {
		border-style: dashed;
		color: var(--primary);
	}
	.recipient.select-all:hover {
		background: var(--primary-subtle);
	}

	input, select, textarea {
		width: 100%;
	}

	.form-actions { margin-top: 1.5rem; }

	.btn {
		padding: 0.625rem 1.25rem;
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.875rem;
		transition: all var(--transition);
	}
	.btn-primary {
		background: var(--primary);
		color: var(--on-primary);
	}
	.btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost {
		color: var(--text-muted);
	}
	.btn-ghost:hover { background: var(--bg); color: var(--text); }

	.reply-context {
		background: var(--bg);
		border: 1px solid var(--border);
		border-left: 3px solid var(--primary);
		border-radius: var(--radius);
		padding: 0.75rem 1rem;
		margin-bottom: 1rem;
	}
	.reply-context-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
		font-size: 0.8rem;
	}
	.reply-label {
		color: var(--text-muted);
		font-weight: 500;
	}
	.reply-from { font-weight: 600; }
	.reply-date { color: var(--text-muted); }
	.reply-subject {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.06rem 0.4rem;
		border-radius: 99px;
		background: var(--primary-subtle);
		color: var(--primary);
	}
	.reply-body {
		font-family: var(--font);
		font-size: 0.825rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-wrap: break-word;
		color: var(--text-muted);
		max-height: 200px;
		overflow-y: auto;
		margin: 0;
	}

	.sent-confirmation {
		text-align: center;
		padding: 3rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
	}
	.sent-icon {
		width: 48px;
		height: 48px;
		border-radius: 50%;
		background: var(--success-subtle);
		color: var(--success);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 1.5rem;
		font-weight: 700;
		margin-bottom: 1rem;
	}
	.sent-confirmation p {
		font-size: 1.1rem;
		font-weight: 600;
		margin-bottom: 1.5rem;
	}
	.sent-actions { display: flex; gap: 0.75rem; justify-content: center; }
</style>
