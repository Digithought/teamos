<script lang="ts">
	import { api } from '../lib/api.js';
	import { identity } from '../lib/identity.svelte.js';
	import type { MemberSummary, Memo, Project, TicketCounts, SiblingInfo } from '../lib/types.js';
	import MemberCard from './MemberCard.svelte';
	import TicketPipeline from './TicketPipeline.svelte';

	let members: MemberSummary[] = $state([]);
	let memos: Memo[] = $state([]);
	let projects: Project[] = $state([]);
	let tickets: TicketCounts | null = $state(null);
	let sibling: SiblingInfo | null = $state(null);
	let loading = $state(true);
	let stopPending = $state(false);
	let stoppingCycle = $state(false);

	let showNewMemo = $state(false);
	let savingMemo = $state(false);
	let memoTitle = $state('');
	let memoContent = $state('');
	let memoImportance = $state('medium');
	let memoAuthor = $state('');
	let memoProjectCodes: string[] = $state([]);
	let memoExpiresAt = $state('');

	async function load() {
		loading = true;
		const [m, memosData, p, t, s, cs] = await Promise.all([
			api.members(),
			api.memos(),
			api.projects(),
			api.tickets(),
			api.sibling().catch(() => null),
			api.cycleStatus().catch(() => ({ stopPending: false })),
		]);
		members = m;
		memos = memosData.items ?? [];
		projects = p.projects ?? [];
		tickets = t;
		sibling = s;
		stopPending = cs.stopPending;
		loading = false;
	}

	$effect(() => { load(); });

	async function cycleStop() {
		stoppingCycle = true;
		await api.cycleStop();
		stopPending = true;
		stoppingCycle = false;
	}

	async function archiveMemo(index: number) {
		await api.archiveMemo(index);
		memos = memos.filter((_, i) => i !== index);
	}

	function openNewMemo() {
		memoTitle = '';
		memoContent = '';
		memoImportance = 'medium';
		memoAuthor = identity.name ?? '';
		memoProjectCodes = [];
		const oneWeek = new Date();
		oneWeek.setDate(oneWeek.getDate() + 7);
		memoExpiresAt = oneWeek.toISOString().slice(0, 10);
		showNewMemo = true;
	}

	function toggleProjectCode(code: string) {
		if (memoProjectCodes.includes(code)) {
			memoProjectCodes = memoProjectCodes.filter(c => c !== code);
		} else {
			memoProjectCodes = [...memoProjectCodes, code];
		}
	}

	async function saveMemo() {
		if (!memoTitle.trim() || !memoContent.trim() || !memoAuthor.trim()) return;
		savingMemo = true;
		const created = await api.createMemo({
			title: memoTitle.trim(),
			content: memoContent.trim(),
			importance: memoImportance,
			authorName: memoAuthor.trim(),
			projectCodes: memoProjectCodes.length ? memoProjectCodes : undefined,
			expiresAt: memoExpiresAt || undefined,
		});
		memos = [...memos, created];
		showNewMemo = false;
		savingMemo = false;
	}

	const hasTickets = $derived(tickets && Object.values(tickets).some((v): v is number => typeof v === 'number' && v > 0));
</script>

{#if loading}
	<div class="loading">Loading...</div>
{:else}
	<section class="section">
		<div class="section-header">
			<h2 class="section-title">Team</h2>
			{#if stopPending}
				<span class="stop-status">Stop pending...</span>
			{:else}
				<button class="stop-btn" onclick={cycleStop} disabled={stoppingCycle}>
					{stoppingCycle ? 'Stopping...' : 'Stop Cycle'}
				</button>
			{/if}
		</div>
		<div class="member-grid">
			{#each members as member}
				<MemberCard {member} />
			{/each}
		</div>
	</section>

	{#if hasTickets && tickets}
		<section class="section">
			<h2 class="section-title">Ticket Pipeline</h2>
			<TicketPipeline {tickets} siblingUrl={sibling?.name === 'tess' ? sibling.url : null} />
		</section>
	{/if}

	<section class="section">
		<div class="section-header">
			<h2 class="section-title">Active Memos</h2>
			{#if !showNewMemo}
				<button class="new-memo-btn" onclick={openNewMemo}>New Memo</button>
			{/if}
		</div>

		{#if showNewMemo}
			<div class="memo-form">
				<div class="form-row">
					<div class="form-group" style="flex:2">
						<label class="label" for="memo-title">Title</label>
						<input id="memo-title" type="text" bind:value={memoTitle} placeholder="Memo title" />
					</div>
					<div class="form-group" style="flex:1">
						<label class="label" for="memo-author">Author</label>
						<input id="memo-author" type="text" bind:value={memoAuthor} placeholder="Your name" />
					</div>
				</div>
				<div class="form-group">
					<label class="label" for="memo-content">Content</label>
					<textarea id="memo-content" bind:value={memoContent} rows="4" placeholder="Memo content..."></textarea>
				</div>
				<div class="form-row">
					<div class="form-group" style="flex:1">
						<label class="label" for="memo-importance">Importance</label>
						<select id="memo-importance" bind:value={memoImportance}>
							<option value="low">Low</option>
							<option value="medium">Medium</option>
							<option value="high">High</option>
							<option value="critical">Critical</option>
						</select>
					</div>
					<div class="form-group" style="flex:1">
						<label class="label" for="memo-expires">Expires (optional)</label>
						<input id="memo-expires" type="date" bind:value={memoExpiresAt} />
					</div>
				</div>
				{#if projects.length > 0}
					<div class="form-group">
						<!-- svelte-ignore a11y_label_has_associated_control -->
					<label class="label">Projects</label>
						<div class="project-tags">
							{#each projects as project}
								<button
									class="project-tag"
									class:selected={memoProjectCodes.includes(project.code)}
									onclick={() => toggleProjectCode(project.code)}
								>{project.name} ({project.code})</button>
							{/each}
						</div>
					</div>
				{/if}
				<div class="form-actions">
					<button
						class="btn btn-primary"
						onclick={saveMemo}
						disabled={!memoTitle.trim() || !memoContent.trim() || !memoAuthor.trim() || savingMemo}
					>{savingMemo ? 'Saving...' : 'Post Memo'}</button>
					<button class="btn btn-ghost" onclick={() => showNewMemo = false}>Cancel</button>
				</div>
			</div>
		{/if}

		{#if memos.length > 0}
			<div class="memos">
				{#each memos as memo, i}
					<div class="memo" class:critical={memo.importance === 'critical'}>
						<div class="memo-header">
							<span class="memo-title">{memo.title}</span>
							<div class="memo-header-right">
								<span class="memo-meta">
									{memo.authorName} &middot; {new Date(memo.postedAt).toLocaleDateString()}
								</span>
								<button class="memo-archive" onclick={() => archiveMemo(i)} title="Archive memo">Archive</button>
							</div>
						</div>
						<p class="memo-content">{memo.content}</p>
						{#if memo.projectCodes?.length}
							<div class="memo-tags">
								{#each memo.projectCodes as code}
									<span class="tag">{code}</span>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{:else if !showNewMemo}
			<p class="no-memos">No active memos.</p>
		{/if}
	</section>
{/if}

<style>
	.loading {
		text-align: center;
		padding: 3rem;
		color: var(--text-muted);
	}
	.section { margin-bottom: 2rem; }
	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.75rem;
	}
	.section-header .section-title { margin-bottom: 0; }
	.stop-btn {
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--danger);
		background: transparent;
		transition: all var(--transition);
	}
	.stop-btn:hover:not(:disabled) {
		background: var(--danger);
		color: var(--on-primary);
	}
	.stop-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.stop-status {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--warning);
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--warning);
		border-radius: var(--radius);
	}
	.section-title {
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		margin-bottom: 0.75rem;
	}
	.member-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0.75rem;
	}
	.memos { display: flex; flex-direction: column; gap: 0.75rem; }
	.memo {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
	}
	.memo.critical { border-left: 3px solid var(--warning); }
	.memo-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
		margin-bottom: 0.5rem;
	}
	.memo-title { font-weight: 600; font-size: 0.925rem; }
	.memo-header-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}
	.memo-meta { font-size: 0.8rem; color: var(--text-muted); white-space: nowrap; }
	.memo-archive {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.2rem 0.5rem;
		border-radius: var(--radius);
		color: var(--text-muted);
		border: 1px solid var(--border);
		transition: all var(--transition);
	}
	.memo-archive:hover { background: var(--bg); color: var(--text); }
	.memo-content {
		font-size: 0.875rem;
		color: var(--text-muted);
		line-height: 1.5;
		white-space: pre-line;
		max-height: 4.5em;
		overflow: hidden;
	}
	.memo-tags { display: flex; gap: 0.375rem; margin-top: 0.5rem; }
	.tag {
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0.125rem 0.5rem;
		border-radius: 99px;
		background: var(--primary-subtle);
		color: var(--primary);
	}
	.new-memo-btn {
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--primary);
		border-radius: var(--radius);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--primary);
		background: transparent;
		transition: all var(--transition);
	}
	.new-memo-btn:hover {
		background: var(--primary);
		color: var(--on-primary);
	}
	.memo-form {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
		margin-bottom: 0.75rem;
	}
	.memo-form .form-row { display: flex; gap: 1rem; }
	.memo-form .form-group { margin-bottom: 0.75rem; }
	.memo-form .label {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-muted);
		margin-bottom: 0.375rem;
	}
	.memo-form input, .memo-form select, .memo-form textarea { width: 100%; }
	.project-tags { display: flex; gap: 0.375rem; flex-wrap: wrap; }
	.project-tag {
		padding: 0.25rem 0.625rem;
		border: 1px solid var(--border);
		border-radius: 99px;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--text-muted);
		background: var(--bg);
		transition: all var(--transition);
	}
	.project-tag:hover { border-color: var(--primary); color: var(--text); }
	.project-tag.selected {
		background: var(--primary);
		color: var(--on-primary);
		border-color: var(--primary);
	}
	.form-actions {
		display: flex;
		gap: 0.75rem;
		margin-top: 0.25rem;
	}
	.btn {
		padding: 0.5rem 1rem;
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.8rem;
		transition: all var(--transition);
	}
	.btn-primary {
		background: var(--primary);
		color: var(--on-primary);
	}
	.btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { color: var(--text-muted); }
	.btn-ghost:hover { background: var(--bg); color: var(--text); }
	.no-memos {
		font-size: 0.875rem;
		color: var(--text-muted);
	}
</style>
