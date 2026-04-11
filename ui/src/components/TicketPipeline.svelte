<script lang="ts">
	import type { TicketCounts } from '../lib/types.js';

	let { tickets, siblingUrl = null }: { tickets: TicketCounts; siblingUrl?: string | null } = $props();

	const stages = [
		{ key: 'fix', label: 'Fix', color: 'var(--danger)' },
		{ key: 'plan', label: 'Plan', color: 'var(--warning)' },
		{ key: 'implement', label: 'Implement', color: 'var(--primary)' },
		{ key: 'review', label: 'Review', color: 'var(--ai)' },
		{ key: 'blocked', label: 'Blocked', color: 'var(--danger)' },
		{ key: 'complete', label: 'Complete', color: 'var(--success)' },
	];

	const total = $derived(Object.values(tickets).reduce((a, b) => a + b, 0));
</script>

<div class="pipeline">
	{#each stages as stage, i}
		{@const count = tickets[stage.key] ?? 0}
		{#if i > 0 && i < 5}
			<span class="arrow">→</span>
		{:else if i === 5}
			<span class="divider"></span>
		{/if}
		<div class="stage" class:has-items={count > 0}>
			<div class="stage-count" style:color={count > 0 ? stage.color : 'var(--text-light)'}>
				{count}
			</div>
			<div class="stage-label">{stage.label}</div>
		</div>
	{/each}
	<div class="total">
		<span class="total-count">{total}</span>
		<span class="total-label">total</span>
	</div>
	{#if siblingUrl}
		<a class="open-link" href={siblingUrl}>Open Tess →</a>
	{/if}
</div>

<style>
	.pipeline {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem 1.25rem;
		flex-wrap: wrap;
	}
	.stage { text-align: center; min-width: 60px; }
	.stage-count {
		font-size: 1.5rem;
		font-weight: 700;
		line-height: 1.2;
	}
	.stage-label {
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
	.arrow {
		color: var(--text-light);
		font-size: 1.25rem;
	}
	.divider {
		width: 1px;
		height: 2rem;
		background: var(--border);
		margin: 0 0.5rem;
	}
	.total {
		margin-left: auto;
		text-align: center;
	}
	.total-count {
		display: block;
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--text);
		line-height: 1.2;
	}
	.total-label {
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
	.open-link {
		font-size: 0.8rem;
		font-weight: 600;
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text-muted);
		transition: all var(--transition);
		text-decoration: none;
		white-space: nowrap;
	}
	.open-link:hover {
		border-color: var(--primary);
		color: var(--primary);
		text-decoration: none;
	}
</style>
