<script lang="ts">
import { api } from '../lib/api.js';
import { identity } from '../lib/identity.svelte.js';
import { router } from '../lib/router.svelte.js';
import type { MailboxCounts, MemberDetail, TodoItem } from '../lib/types.js';
import Mailbox from './Mailbox.svelte';
import MemberChat from './MemberChat.svelte';
import MemberLogs from './MemberLogs.svelte';

const { name }: { name: string } = $props();

let detail = $state<MemberDetail | null>(null);
let loading = $state(true);
let tab = $state<'messages' | 'chat' | 'todos' | 'state' | 'schedule' | 'logs'>('messages');
/** Reported up by <Mailbox> so the tab badge doesn't need a second fetch of the same mailboxes. */
let mailCounts = $state<MailboxCounts | null>(null);

const isMe = $derived(identity.name === name);

async function load() {
	loading = true;
	detail = await api.member(name);
	loading = false;
	if (router.query.msg) tab = 'messages';
}

$effect(() => {
	name;
	load();
});

let newTodoTitle = $state('');
let newTodoPriority = $state('today');

async function addTodo() {
	if (!newTodoTitle.trim() || !detail) return;
	const items = [...detail.todos.items, { title: newTodoTitle.trim(), priority: newTodoPriority, status: 'pending' }];
	await api.updateTodos(name, { items });
	detail.todos.items = items;
	newTodoTitle = '';
}

async function removeTodo(idx: number) {
	if (!detail) return;
	const items = detail.todos.items.filter((_, i) => i !== idx);
	await api.updateTodos(name, { items });
	detail.todos.items = items;
}

async function toggleTodoStatus(idx: number) {
	if (!detail) return;
	const items = [...detail.todos.items];
	const item = { ...items[idx] };
	item.status = item.status === 'done' ? 'pending' : 'done';
	items[idx] = item;
	await api.updateTodos(name, { items });
	detail.todos.items = items;
}

let newEventTitle = $state('');
let newEventTime = $state('');

async function addEvent() {
	if (!newEventTime || !detail) return;
	const title = newEventTitle.trim() || '(untitled)';
	await api.addEvent(name, {
		title,
		time: new Date(newEventTime).toISOString(),
	});
	const fresh = await api.schedule(name);
	detail.schedule.events = fresh.events as typeof detail.schedule.events;
	newEventTitle = '';
	newEventTime = '';
}

async function removeEvent(id: string) {
	if (!detail || !id) return;
	await api.removeEvent(name, id);
	detail.schedule.events = detail.schedule.events.filter((e) => (e as { id?: string }).id !== id);
}

function priorityColor(p: string): string {
	const map: Record<string, string> = {
		pressing: 'var(--danger)',
		today: 'var(--warning)',
		thisWeek: 'var(--primary)',
		later: 'var(--text-light)',
	};
	return map[p] ?? 'var(--text-muted)';
}

function groupByPriority(items: TodoItem[]): [string, TodoItem[]][] {
	const order = ['pressing', 'today', 'thisWeek', 'later'];
	const groups = new Map<string, TodoItem[]>();
	for (const item of items) {
		const p = item.priority ?? 'later';
		if (!groups.has(p)) groups.set(p, []);
		groups.get(p)!.push(item);
	}
	return order.filter((p) => groups.has(p)).map((p) => [p, groups.get(p)!]);
}

const todoGroups = $derived(detail ? groupByPriority(detail.todos.items) : []);
let editingState = $state(false);
let stateText = $state('');
let savingState = $state(false);

function startEditState() {
	stateText = detail?.state ?? '';
	editingState = true;
}

async function saveState() {
	if (!detail) return;
	savingState = true;
	await api.updateState(name, stateText);
	detail.state = stateText;
	editingState = false;
	savingState = false;
}

function cancelEditState() {
	editingState = false;
}

const profileMeta = $derived(detail?.profile.meta ?? {});

let editingProfile = $state(false);
let savingProfile = $state(false);
let profileError = $state('');
let editTitle = $state('');
let editType = $state<'ai' | 'human'>('ai');
let editActive = $state(true);
let editRoles = $state('');
let editDescription = $state('');
let editBody = $state('');

function startEditProfile() {
	if (!detail) return;
	const meta = detail.profile.meta as Record<string, unknown>;
	editTitle = (meta.title as string) ?? '';
	editType = (meta.type as 'ai' | 'human') ?? 'ai';
	editActive = meta.active !== false;
	const roles = Array.isArray(meta.roles) ? (meta.roles as string[]) : [];
	editRoles = roles.join(', ');
	editDescription = (meta.description as string) ?? '';
	editBody = detail.profile.body ?? '';
	profileError = '';
	editingProfile = true;
}

async function saveProfile() {
	if (!detail) return;
	savingProfile = true;
	profileError = '';
	try {
		const roles = editRoles
			.split(',')
			.map((r) => r.trim())
			.filter(Boolean);
		await api.updateMemberProfile(name, {
			title: editTitle.trim(),
			type: editType,
			active: editActive,
			roles,
			description: editDescription.trim(),
			body: editBody,
		});
		editingProfile = false;
		await load();
	} catch (err) {
		profileError = err instanceof Error ? err.message : 'Failed to save';
	} finally {
		savingProfile = false;
	}
}

async function deleteMember() {
	if (!detail) return;
	const confirmed = window.confirm(
		`Delete member "${name}"? This will remove their profile, mailbox, todos, and schedule. This cannot be undone.`,
	);
	if (!confirmed) return;
	try {
		await api.deleteMember(name);
		router.navigate('/');
	} catch (err) {
		profileError = err instanceof Error ? err.message : 'Failed to delete';
	}
}
</script>

{#if loading}
	<div class="loading">Loading...</div>
{:else if detail}
	<div class="header">
		<button class="back" onclick={() => router.navigate('/')}>← Back</button>
		<div class="header-info">
			<h1 class="name">
				{detail.name}
				{#if isMe}<span class="you-tag">you</span>{/if}
			</h1>
			<span class="title">{profileMeta.title ?? ''}</span>
			<span class="type-badge" class:human={profileMeta.type === 'human'} class:ai={profileMeta.type === 'ai'}>
				{profileMeta.type ?? 'unknown'}
			</span>
		</div>
		<div class="header-actions">
			<a class="compose-btn" href="#/compose">Send Message</a>
			{#if !editingProfile}
				<button class="edit-btn" onclick={startEditProfile}>Edit</button>
			{/if}
			<button class="delete-btn" onclick={deleteMember}>Delete</button>
		</div>
	</div>

	{#if editingProfile}
		<div class="profile-form">
			<div class="form-row">
				<div class="form-group" style="flex:2">
					<label class="label" for="edit-title">Title</label>
					<input id="edit-title" type="text" bind:value={editTitle} />
				</div>
				<div class="form-group" style="flex:1">
					<label class="label" for="edit-type">Type</label>
					<select id="edit-type" bind:value={editType}>
						<option value="ai">ai</option>
						<option value="human">human</option>
					</select>
				</div>
				<div class="form-group" style="flex:0 0 auto">
					<label class="label" for="edit-active">Active</label>
					<label class="checkbox-label">
						<input id="edit-active" type="checkbox" bind:checked={editActive} />
						<span>active</span>
					</label>
				</div>
			</div>
			<div class="form-group">
				<label class="label" for="edit-roles">Roles (comma separated)</label>
				<input id="edit-roles" type="text" bind:value={editRoles} />
			</div>
			<div class="form-group">
				<label class="label" for="edit-description">Description</label>
				<textarea id="edit-description" rows="2" bind:value={editDescription}></textarea>
			</div>
			<div class="form-group">
				<label class="label" for="edit-body">Profile body (markdown)</label>
				<textarea id="edit-body" rows="6" bind:value={editBody}></textarea>
			</div>
			{#if profileError}
				<div class="form-error">{profileError}</div>
			{/if}
			<div class="form-actions">
				<button class="add-btn" onclick={saveProfile} disabled={savingProfile}>
					{savingProfile ? 'Saving...' : 'Save'}
				</button>
				<button class="cancel-btn" onclick={() => editingProfile = false}>Cancel</button>
			</div>
		</div>
	{/if}

	{#if profileMeta.roles}
		<div class="roles">
			{#each (Array.isArray(profileMeta.roles) ? profileMeta.roles : []) as role}
				<span class="role-tag">{role}</span>
			{/each}
		</div>
	{/if}

	<div class="tabs">
		<button class="tab" class:active={tab === 'messages'} onclick={() => tab = 'messages'}>
			Messages {#if mailCounts && mailCounts.inboxMessages > 0}<span class="badge">{mailCounts.inboxMessages}</span>{/if}
		</button>
		<button class="tab" class:active={tab === 'chat'} onclick={() => tab = 'chat'}>Chat</button>
		<button class="tab" class:active={tab === 'todos'} onclick={() => tab = 'todos'}>
			Todos {#if detail.todos.items.length > 0}<span class="badge">{detail.todos.items.length}</span>{/if}
		</button>
		<button class="tab" class:active={tab === 'state'} onclick={() => tab = 'state'}>State</button>
		<button class="tab" class:active={tab === 'schedule'} onclick={() => tab = 'schedule'}>
			Schedule {#if detail.schedule.events.length > 0}<span class="badge">{detail.schedule.events.length}</span>{/if}
		</button>
		<button class="tab" class:active={tab === 'logs'} onclick={() => tab = 'logs'}>Logs</button>
	</div>

	<div class="tab-content">
		{#if tab === 'messages'}
			<Mailbox {name} oncounts={(c) => (mailCounts = c)} />

		{:else if tab === 'chat'}
			<MemberChat {name} />

		{:else if tab === 'logs'}
			<MemberLogs {name} />

		{:else if tab === 'todos'}
			<div class="add-form">
				<input class="add-input" type="text" placeholder="New todo..." bind:value={newTodoTitle} onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') addTodo(); }} />
				<select class="add-select" bind:value={newTodoPriority}>
					<option value="pressing">pressing</option>
					<option value="today">today</option>
					<option value="thisWeek">thisWeek</option>
					<option value="later">later</option>
				</select>
				<button class="add-btn" onclick={addTodo}>Add</button>
			</div>
			{#if todoGroups.length === 0}
				<div class="empty">No todos</div>
			{:else}
				{#each todoGroups as [priority, items]}
					<div class="todo-group">
						<h3 class="todo-priority" style:color={priorityColor(priority)}>{priority}</h3>
						{#each items as item, i}
							{@const globalIdx = detail!.todos.items.indexOf(item)}
							<div class="todo-item" class:blocked={item.status === 'blocked'} class:done={item.status === 'done'}>
								<div class="todo-title">
									<button class="todo-check" onclick={() => toggleTodoStatus(globalIdx)} title={item.status === 'done' ? 'Mark pending' : 'Mark done'}>
										{item.status === 'done' ? '✓' : '○'}
									</button>
									<span class:strikethrough={item.status === 'done'}>{item.title}</span>
									{#if item.status === 'blocked'}
										<span class="blocked-badge">blocked</span>
									{/if}
									{#if item.projectCode}
										<span class="project-badge">{item.projectCode}</span>
									{/if}
									<button class="todo-remove" onclick={() => removeTodo(globalIdx)} title="Remove">×</button>
								</div>
								{#if item.notes || item.description}
									<div class="todo-notes">{item.notes ?? item.description}</div>
								{/if}
							</div>
						{/each}
					</div>
				{/each}
			{/if}

		{:else if tab === 'state'}
			<div class="state-content">
				{#if editingState}
					<textarea class="state-editor" bind:value={stateText}></textarea>
					<div class="state-actions">
						<button class="add-btn" onclick={saveState} disabled={savingState}>
							{savingState ? 'Saving...' : 'Save'}
						</button>
						<button class="cancel-btn" onclick={cancelEditState}>Cancel</button>
					</div>
				{:else}
					<pre class="state-text">{detail.state || 'No state information'}</pre>
					<button class="edit-state-btn" onclick={startEditState}>Edit</button>
				{/if}
			</div>

		{:else if tab === 'schedule'}
			<div class="add-form">
				<input class="add-input" type="datetime-local" bind:value={newEventTime} />
				<input class="add-input" type="text" placeholder="Event title..." bind:value={newEventTitle} onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') addEvent(); }} />
				<button class="add-btn" onclick={addEvent}>Add</button>
			</div>
			{#if detail.schedule.events.length === 0}
				<div class="empty">No scheduled events</div>
			{:else}
				{#each detail.schedule.events as event (event.id)}
					<div class="event">
						<span class="event-time">{new Date(event.time).toLocaleString()}</span>
						{#if event.title}
							<span class="event-title">{event.title}</span>
						{/if}
						<button class="event-remove" onclick={() => removeEvent(event.id)} title="Remove">×</button>
					</div>
				{/each}
			{/if}
		{/if}
	</div>
{/if}

<style>
	.loading { text-align: center; padding: 3rem; color: var(--text-muted); }
	.header {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 0.75rem;
	}
	.back {
		color: var(--text-muted);
		font-size: 0.875rem;
		padding: 0.375rem 0.75rem;
		border-radius: var(--radius);
		transition: all var(--transition);
	}
	.back:hover { background: var(--surface); color: var(--text); }
	.header-info {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		flex: 1;
	}
	.name {
		font-size: 1.5rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		gap: 0.5rem;
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
	.title { color: var(--text-muted); font-size: 0.9rem; }
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
	.compose-btn {
		padding: 0.5rem 1rem;
		background: var(--primary);
		color: var(--on-primary);
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.875rem;
		transition: background var(--transition);
		text-decoration: none;
	}
	.compose-btn:hover { background: var(--primary-hover); text-decoration: none; }
	.header-actions { display: flex; gap: 0.5rem; align-items: center; }
	.edit-btn {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.8rem;
		color: var(--text-muted);
		background: var(--surface);
		transition: all var(--transition);
	}
	.edit-btn:hover { background: var(--bg); color: var(--text); }
	.delete-btn {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.8rem;
		color: var(--danger);
		background: transparent;
		transition: all var(--transition);
	}
	.delete-btn:hover { background: var(--danger); color: var(--on-primary); }
	.profile-form {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
		margin-bottom: 1rem;
	}
	.profile-form .form-row { display: flex; gap: 1rem; align-items: flex-end; }
	.profile-form .form-group { margin-bottom: 0.75rem; }
	.profile-form .label {
		display: block;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-muted);
		margin-bottom: 0.25rem;
	}
	.profile-form input[type="text"],
	.profile-form select,
	.profile-form textarea {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-family: var(--font);
		font-size: 0.875rem;
		background: var(--bg);
		color: var(--text);
	}
	.profile-form input:focus, .profile-form select:focus, .profile-form textarea:focus {
		outline: none;
		border-color: var(--primary);
	}
	.checkbox-label {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.875rem;
		color: var(--text);
		padding: 0.5rem 0;
	}
	.form-error {
		font-size: 0.8rem;
		color: var(--danger);
		padding: 0.5rem 0.75rem;
		background: var(--danger-subtle);
		border-radius: var(--radius);
		margin-bottom: 0.5rem;
	}
	.form-actions { display: flex; gap: 0.5rem; }
	.roles { display: flex; gap: 0.375rem; margin-bottom: 1rem; }
	.role-tag {
		font-size: 0.7rem;
		font-weight: 500;
		padding: 0.125rem 0.5rem;
		border-radius: 99px;
		background: var(--bg);
		color: var(--text-muted);
		border: 1px solid var(--border);
	}

	.tabs {
		display: flex;
		gap: 0.25rem;
		border-bottom: 1px solid var(--border);
		margin-bottom: 1rem;
	}
	.tab {
		padding: 0.625rem 1rem;
		font-weight: 500;
		font-size: 0.875rem;
		color: var(--text-muted);
		border-bottom: 2px solid transparent;
		transition: all var(--transition);
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.tab:hover { color: var(--text); }
	.tab.active { color: var(--primary); border-bottom-color: var(--primary); }
	.badge {
		font-size: 0.7rem;
		font-weight: 700;
		padding: 0.06rem 0.4rem;
		border-radius: 99px;
		background: var(--primary-subtle);
		color: var(--primary);
	}

	.tab-content {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
	}
	.empty { text-align: center; padding: 2rem; color: var(--text-muted); font-style: italic; }

	.todo-group { margin-bottom: 1.25rem; }
	.todo-group:last-child { margin-bottom: 0; }
	.todo-priority {
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-bottom: 0.5rem;
	}
	.todo-item {
		padding: 0.625rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 0.375rem;
	}
	.todo-item.blocked { border-left: 3px solid var(--danger); }
	.todo-title {
		font-weight: 600;
		font-size: 0.875rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.blocked-badge {
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		padding: 0.06rem 0.4rem;
		border-radius: 99px;
		background: var(--danger-subtle);
		color: var(--danger);
	}
	.project-badge {
		font-size: 0.65rem;
		font-weight: 600;
		padding: 0.06rem 0.4rem;
		border-radius: 99px;
		background: var(--primary-subtle);
		color: var(--primary);
	}
	.todo-notes {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin-top: 0.25rem;
		line-height: 1.5;
	}

	.state-content {
		max-height: 600px;
		overflow-y: auto;
	}
	.state-text {
		font-family: var(--font);
		font-size: 0.875rem;
		line-height: 1.7;
		white-space: pre-wrap;
		word-wrap: break-word;
	}
	.state-editor {
		width: 100%;
		min-height: 300px;
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-family: var(--font);
		font-size: 0.875rem;
		line-height: 1.7;
		background: var(--bg);
		color: var(--text);
		resize: vertical;
	}
	.state-editor:focus { outline: none; border-color: var(--primary); }
	.state-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}
	.cancel-btn {
		padding: 0.5rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.875rem;
		color: var(--text-muted);
		transition: all var(--transition);
	}
	.cancel-btn:hover { background: var(--bg); color: var(--text); }
	.edit-state-btn {
		margin-top: 0.75rem;
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.8rem;
		color: var(--text-muted);
		transition: all var(--transition);
	}
	.edit-state-btn:hover { background: var(--bg); color: var(--text); }

	.event {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 0.375rem;
		display: flex;
		gap: 1rem;
		align-items: center;
	}
	.event-time { font-weight: 600; font-size: 0.875rem; }
	.event-title { color: var(--text-muted); font-size: 0.875rem; flex: 1; }
	.event-remove {
		margin-left: auto;
		color: var(--text-light);
		font-size: 1.1rem;
		line-height: 1;
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius);
		transition: all var(--transition);
	}
	.event-remove:hover { color: var(--danger); background: var(--danger-subtle); }

	.add-form {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1rem;
		align-items: center;
	}
	.add-input {
		flex: 1;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-size: 0.875rem;
		background: var(--bg);
		color: var(--text);
	}
	.add-input:focus { outline: none; border-color: var(--primary); }
	.add-select {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-size: 0.875rem;
		background: var(--bg);
		color: var(--text);
	}
	.add-btn {
		padding: 0.5rem 1rem;
		background: var(--primary);
		color: var(--on-primary);
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.875rem;
		transition: background var(--transition);
	}
	.add-btn:hover { background: var(--primary-hover); }

	.todo-check {
		font-size: 0.9rem;
		width: 1.5rem;
		height: 1.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		border: 1px solid var(--border);
		flex-shrink: 0;
		transition: all var(--transition);
		color: var(--text-muted);
	}
	.todo-check:hover { border-color: var(--primary); color: var(--primary); }
	.todo-item.done .todo-check { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
	.todo-remove {
		margin-left: auto;
		color: var(--text-light);
		font-size: 1.1rem;
		line-height: 1;
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius);
		transition: all var(--transition);
	}
	.todo-remove:hover { color: var(--danger); background: var(--danger-subtle); }
	.strikethrough { text-decoration: line-through; opacity: 0.5; }
	.todo-item.done { opacity: 0.6; }
</style>
