<script lang="ts">
	import { identity } from '../lib/identity.svelte.js';
	import { api } from '../lib/api.js';
	import type { MemberSummary } from '../lib/types.js';

	let members: MemberSummary[] = $state([]);
	let open = $state(false);
	let loaded = $state(false);

	async function load() {
		members = await api.members();
		loaded = true;
	}

	$effect(() => { load(); });

	function pick(name: string) {
		identity.set(name);
		open = false;
	}
</script>

{#if !identity.isSet && loaded}
	<div class="overlay">
		<div class="picker-card">
			<h2 class="picker-title">Who are you?</h2>
			<p class="picker-hint">Select your identity to get started</p>
			<div class="picker-list">
				{#each members as member}
					<button class="picker-member" onclick={() => pick(member.name)}>
						<span class="picker-name">{member.name}</span>
						<span class="picker-meta">{member.title}</span>
						<span class="picker-type" class:human={member.type === 'human'} class:ai={member.type === 'ai'}>
							{member.type}
						</span>
					</button>
				{/each}
			</div>
		</div>
	</div>
{/if}

{#if identity.isSet}
	<div class="identity-indicator">
		<button class="identity-btn" onclick={() => open = !open}>
			{identity.name}
			<span class="identity-caret">{open ? '▲' : '▼'}</span>
		</button>
		{#if open}
			<div class="identity-menu">
				{#each members as member}
					<button
						class="identity-option"
						class:current={identity.name === member.name}
						onclick={() => pick(member.name)}
					>
						{member.name}
						<span class="option-title">{member.title}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: var(--overlay);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}
	.picker-card {
		background: var(--surface);
		border-radius: var(--radius-lg);
		padding: 2rem;
		width: 380px;
		max-width: 90vw;
		box-shadow: var(--shadow-lg);
	}
	.picker-title {
		font-size: 1.25rem;
		font-weight: 700;
		margin-bottom: 0.25rem;
	}
	.picker-hint {
		font-size: 0.85rem;
		color: var(--text-muted);
		margin-bottom: 1.25rem;
	}
	.picker-list { display: flex; flex-direction: column; gap: 0.375rem; }
	.picker-member {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		text-align: left;
		transition: all var(--transition);
	}
	.picker-member:hover {
		border-color: var(--primary);
		background: var(--primary-subtle);
	}
	.picker-name { font-weight: 600; }
	.picker-meta {
		flex: 1;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.picker-type {
		font-size: 0.6rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0.125rem 0.5rem;
		border-radius: 99px;
	}
	.picker-type.human { background: var(--human-subtle); color: var(--human); }
	.picker-type.ai { background: var(--ai-subtle); color: var(--ai); }

	.identity-indicator { position: relative; }
	.identity-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.75rem;
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.875rem;
		color: var(--text);
		transition: all var(--transition);
	}
	.identity-btn:hover { background: var(--bg); }
	.identity-caret { font-size: 0.6rem; color: var(--text-muted); }
	.identity-menu {
		position: absolute;
		right: 0;
		top: 100%;
		margin-top: 0.25rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-lg);
		min-width: 220px;
		z-index: 200;
		overflow: hidden;
	}
	.identity-option {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.75rem;
		width: 100%;
		text-align: left;
		font-size: 0.85rem;
		font-weight: 500;
		transition: background var(--transition);
	}
	.identity-option:hover { background: var(--bg); }
	.identity-option.current { color: var(--primary); font-weight: 600; }
	.option-title {
		flex: 1;
		font-size: 0.75rem;
		color: var(--text-muted);
		text-align: right;
	}
</style>
