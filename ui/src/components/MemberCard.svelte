<script lang="ts">
	import type { MemberSummary } from '../lib/types.js';
	import { identity } from '../lib/identity.svelte.js';

	let { member }: { member: MemberSummary } = $props();

	const isMe = $derived(identity.name === member.name);
</script>

<a class="card" class:is-me={isMe} href="#/member/{member.name}">
	<div class="card-header">
		<span class="name">
			{member.name}
			{#if isMe}<span class="you-tag">you</span>{/if}
		</span>
		<span class="type-badge" class:human={member.type === 'human'} class:ai={member.type === 'ai'}>
			{member.type}
		</span>
	</div>
	<div class="title">{member.title}</div>
	<div class="stats">
		{#if member.inboxCount > 0}
			<span class="stat inbox">
				<span class="stat-icon">✉</span>
				{member.inboxCount}
			</span>
		{/if}
		{#if member.todoCount > 0}
			<span class="stat">
				<span class="stat-icon">&#9745;</span>
				{member.todoCount}
			</span>
		{/if}
		{#if member.blockedCount > 0}
			<span class="stat blocked">
				<span class="stat-icon">&#9888;</span>
				{member.blockedCount} blocked
			</span>
		{/if}
		{#if member.eventCount > 0}
			<span class="stat">
				<span class="stat-icon">&#128339;</span>
				{member.eventCount}
			</span>
		{/if}
		{#if member.todoCount === 0 && member.inboxCount === 0 && member.eventCount === 0}
			<span class="stat idle">idle</span>
		{/if}
	</div>
</a>

<style>
	.card {
		display: block;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
		transition: all var(--transition);
		text-decoration: none;
		color: inherit;
	}
	.card:hover {
		border-color: var(--primary);
		box-shadow: var(--shadow-lg);
		transform: translateY(-1px);
		text-decoration: none;
	}
	.card.is-me {
		border-color: var(--human);
		border-width: 2px;
	}
	.card-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.25rem;
	}
	.name {
		font-weight: 700;
		font-size: 1rem;
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.you-tag {
		font-size: 0.6rem;
		font-weight: 700;
		text-transform: uppercase;
		padding: 0.06rem 0.375rem;
		border-radius: 99px;
		background: var(--human-subtle);
		color: var(--human);
	}
	.type-badge {
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0.125rem 0.5rem;
		border-radius: 99px;
	}
	.type-badge.human { background: var(--human-subtle); color: var(--human); }
	.type-badge.ai { background: var(--ai-subtle); color: var(--ai); }
	.title {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin-bottom: 0.75rem;
	}
	.stats {
		display: flex;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.stat {
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--text-muted);
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.stat-icon { font-size: 0.9rem; }
	.stat.inbox { color: var(--primary); font-weight: 600; }
	.stat.blocked { color: var(--danger); font-weight: 600; }
	.stat.idle { color: var(--text-light); font-style: italic; }
</style>
