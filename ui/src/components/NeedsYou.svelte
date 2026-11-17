<script lang="ts">
import { api } from '../lib/api.js';
import { identity } from '../lib/identity.svelte.js';
import type { Attention, FyiItem, MemberSummary } from '../lib/types.js';

/**
 * What a human member has to look at: open `decide` questions, each with the
 * default that goes ahead if they stay silent, and a skimmable digest of FYI
 * mail grouped by day. Agents' FYI never reaches the human's inbox; this is
 * where it lands.
 */

let humans = $state<MemberSummary[]>([]);
let who = $state<string | null>(null);
let attention = $state<Attention | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);

$effect(() => {
	api
		.members()
		.then((m) => {
			humans = m.filter((x) => x.type === 'human');
			const me = humans.find((h) => h.name === identity.name);
			who = me?.name ?? humans[0]?.name ?? null;
			if (!who) loading = false;
		})
		.catch((err) => {
			error = err instanceof Error ? err.message : String(err);
			loading = false;
		});
});

$effect(() => {
	const name = who;
	if (!name) return;
	loading = true;
	api
		.attention(name)
		.then((a) => {
			if (who === name) attention = a;
		})
		.catch((err) => (error = err instanceof Error ? err.message : String(err)))
		.finally(() => (loading = false));
});

/** FYI grouped by the local day it was sent, newest day first. */
const days = $derived.by(() => {
	const groups: { day: string; items: FyiItem[] }[] = [];
	for (const item of attention?.fyi ?? []) {
		const day = new Date(item.sentAt).toLocaleDateString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
		});
		const last = groups[groups.length - 1];
		if (last && last.day === day) last.items.push(item);
		else groups.push({ day, items: [item] });
	}
	return groups;
});

function threadHref(id: string): string {
	return `#/member/${encodeURIComponent(who ?? '')}?msg=${encodeURIComponent(id)}`;
}

function answerHref(id: string): string {
	return `#/compose?re=${encodeURIComponent(id)}&inbox=${encodeURIComponent(who ?? '')}`;
}

function time(iso: string): string {
	return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}
</script>

<div class="needs">
	<div class="header">
		<h1 class="title">Needs you</h1>
		{#if humans.length > 1}
			<select bind:value={who} aria-label="Human member">
				{#each humans as h}
					<option value={h.name}>{h.name}</option>
				{/each}
			</select>
		{:else if who}
			<span class="who">{who}</span>
		{/if}
	</div>

	{#if error}
		<div class="empty">{error}</div>
	{:else if !who && !loading}
		<div class="empty">No human members in members.json.</div>
	{:else if loading && !attention}
		<div class="empty">Loading...</div>
	{:else if attention}
		<section class="section">
			<p class="hint">
				One question each. If you say nothing, the default goes ahead after its date. Reply in the thread to
				answer; that closes it.
			</p>
			{#if attention.needs.length === 0}
				<div class="empty small">Nothing is waiting on you.</div>
			{:else}
				<div class="list">
					{#each attention.needs as item (item.id)}
						<div class="item" class:overdue={item.overdue}>
							<div class="item-top">
								<a class="item-subject" href={threadHref(item.id)}>{item.subject}</a>
								<span class="item-from">{item.from}</span>
							</div>
							<div class="item-default">
								<span class="badge" class:late={item.overdue}>
									{item.overdue ? 'overdue' : 'by'}
									{item.defaultBy}
								</span>
								<span class="default-label">Default:</span>
								<span class="default-text">{item.default}</span>
								<a class="answer" href={answerHref(item.id)}>Answer</a>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<section class="section">
			<h2 class="section-title">FYI <span class="muted">last {attention.fyiDays} days</span></h2>
			{#if days.length === 0}
				<div class="empty small">No FYI.</div>
			{:else}
				{#each days as group, i (group.day)}
					<details class="day" open={i === 0}>
						<summary>
							<span class="day-name">{group.day}</span>
							<span class="day-count">{group.items.length}</span>
						</summary>
						{#each group.items as item (item.id)}
							<a class="fyi" href={threadHref(item.id)}>
								<span class="fyi-time">{time(item.sentAt)}</span>
								<span class="fyi-from">{item.from}</span>
								<span class="fyi-subject">{item.subject}</span>
								<span class="fyi-preview">{item.preview}</span>
							</a>
						{/each}
					</details>
				{/each}
			{/if}
		</section>
	{/if}
</div>

<style>
	.needs { max-width: 900px; }
	.header { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; }
	.title { font-size: 1.25rem; font-weight: 700; }
	.who { font-size: 0.85rem; color: var(--text-muted); }
	.header select { width: auto; }
	.hint { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.75rem; }

	.section { margin-bottom: 2rem; }
	.section-title { font-size: 1rem; font-weight: 700; margin-bottom: 0.5rem; }
	.muted { font-size: 0.75rem; font-weight: 500; color: var(--text-light); }

	.list { display: flex; flex-direction: column; gap: 0.5rem; }
	.item {
		background: var(--surface);
		border: 1px solid var(--border);
		border-left: 3px solid var(--primary);
		border-radius: var(--radius);
		padding: 0.6rem 0.8rem;
	}
	.item.overdue { border-left-color: var(--danger); background: var(--danger-subtle); }
	.item-top { display: flex; align-items: baseline; gap: 0.75rem; }
	.item-subject { flex: 1; min-width: 0; font-weight: 700; font-size: 0.9rem; color: var(--text); }
	.item-from { font-size: 0.75rem; color: var(--text-muted); flex-shrink: 0; }
	.item-default {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.35rem;
		font-size: 0.8rem;
	}
	.badge {
		font-size: 0.68rem;
		font-weight: 700;
		padding: 0.05rem 0.45rem;
		border-radius: 99px;
		background: var(--primary-subtle);
		color: var(--primary);
	}
	.badge.late { background: var(--danger); color: var(--on-primary); }
	.default-label { color: var(--text-muted); font-weight: 600; }
	.default-text { flex: 1; min-width: 0; }
	.answer {
		padding: 0.2rem 0.6rem;
		border-radius: var(--radius);
		font-size: 0.75rem;
		font-weight: 600;
		background: var(--primary-subtle);
		color: var(--primary);
	}
	.answer:hover { background: var(--primary); color: var(--on-primary); text-decoration: none; }

	.day {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		margin-bottom: 0.375rem;
	}
	.day summary {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.45rem 0.7rem;
		cursor: pointer;
		font-size: 0.82rem;
		font-weight: 600;
	}
	.day-count {
		font-size: 0.65rem;
		font-weight: 700;
		padding: 0.02rem 0.35rem;
		border-radius: 99px;
		background: var(--border);
		color: var(--text-muted);
	}
	.fyi {
		display: flex;
		gap: 0.6rem;
		align-items: baseline;
		padding: 0.3rem 0.7rem;
		border-top: 1px solid var(--border);
		font-size: 0.78rem;
		color: var(--text);
	}
	.fyi:hover { background: var(--surface-raised); text-decoration: none; }
	.fyi-time { color: var(--text-light); flex-shrink: 0; width: 4.5rem; }
	.fyi-from { color: var(--text-muted); flex-shrink: 0; font-weight: 600; }
	.fyi-subject { flex-shrink: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.fyi-preview {
		flex: 1;
		min-width: 0;
		color: var(--text-light);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.empty { text-align: center; padding: 2rem; color: var(--text-muted); font-style: italic; }
	.empty.small { padding: 1rem; font-size: 0.8rem; }
</style>
