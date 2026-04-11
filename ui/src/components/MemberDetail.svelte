<script lang="ts">
	import { api } from '../lib/api.js';
	import { router } from '../lib/router.svelte.js';
	import { identity } from '../lib/identity.svelte.js';
	import type { MemberDetail, InboxMessage, TodoItem } from '../lib/types.js';

	let { name }: { name: string } = $props();

	let detail: MemberDetail | null = $state(null);
	let inbox: InboxMessage[] = $state([]);
	let archives: InboxMessage[] = $state([]);
	let showArchives = $state(false);
	let loading = $state(true);
	let tab: 'inbox' | 'todos' | 'state' | 'schedule' = $state('inbox');
	let expandedMsg: string | null = $state(null);

	const isMe = $derived(identity.name === name);

	async function load() {
		loading = true;
		const [d, inb, arch] = await Promise.all([
			api.member(name),
			api.inbox(name),
			api.archives(name),
		]);
		detail = d;
		inbox = inb;
		archives = arch;
		loading = false;
	}

	$effect(() => { name; load(); });

	async function deleteMessage(filename: string) {
		await api.deleteMessage(name, filename);
		inbox = inbox.filter(m => m.filename !== filename);
	}

	async function archiveMessage(filename: string) {
		await api.archiveMessage(name, filename);
		inbox = inbox.filter(m => m.filename !== filename);
		archives = await api.archives(name);
	}

	async function deleteArchive(filename: string) {
		await api.deleteArchive(name, filename);
		archives = archives.filter(m => m.filename !== filename);
	}

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
		const events = [...detail.schedule.events, { time: new Date(newEventTime).toISOString(), title: newEventTitle.trim() || undefined }];
		await api.updateSchedule(name, { events });
		detail.schedule.events = events;
		newEventTitle = '';
		newEventTime = '';
	}

	async function removeEvent(idx: number) {
		if (!detail) return;
		const events = detail.schedule.events.filter((_, i) => i !== idx);
		await api.updateSchedule(name, { events });
		detail.schedule.events = events;
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
		return order.filter(p => groups.has(p)).map(p => [p, groups.get(p)!]);
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
		<a class="compose-btn" href="#/compose?to={name}">Send Message</a>
	</div>

	{#if profileMeta.roles}
		<div class="roles">
			{#each (Array.isArray(profileMeta.roles) ? profileMeta.roles : []) as role}
				<span class="role-tag">{role}</span>
			{/each}
		</div>
	{/if}

	<div class="tabs">
		<button class="tab" class:active={tab === 'inbox'} onclick={() => tab = 'inbox'}>
			Inbox {#if inbox.length > 0}<span class="badge">{inbox.length}</span>{/if}
		</button>
		<button class="tab" class:active={tab === 'todos'} onclick={() => tab = 'todos'}>
			Todos {#if detail.todos.items.length > 0}<span class="badge">{detail.todos.items.length}</span>{/if}
		</button>
		<button class="tab" class:active={tab === 'state'} onclick={() => tab = 'state'}>State</button>
		<button class="tab" class:active={tab === 'schedule'} onclick={() => tab = 'schedule'}>
			Schedule {#if detail.schedule.events.length > 0}<span class="badge">{detail.schedule.events.length}</span>{/if}
		</button>
	</div>

	<div class="tab-content">
		{#if tab === 'inbox'}
			{#if inbox.length === 0}
				<div class="empty">No inbox messages</div>
			{:else}
				<div class="messages">
					{#each inbox as msg}
						<div class="message" class:expanded={expandedMsg === msg.filename}>
							<button class="message-header" onclick={() => expandedMsg = expandedMsg === msg.filename ? null : msg.filename}>
								<span class="msg-from">From: {msg.from}</span>
								<span class="msg-date">{new Date(msg.sentAt).toLocaleString()}</span>
								{#if msg.projectCode}
									<span class="msg-project">{msg.projectCode}</span>
								{/if}
								{#if msg.requestResponse}
									<span class="msg-rr">reply requested</span>
								{/if}
								<span class="msg-toggle">{expandedMsg === msg.filename ? '▼' : '▶'}</span>
							</button>
							{#if expandedMsg === msg.filename}
								<div class="message-body">
									<pre class="msg-text">{msg.body}</pre>
									<div class="msg-actions">
										<a class="action-btn reply" href="#/compose?to={msg.from}&re={msg.filename}&inbox={name}">Reply</a>
										<button class="action-btn archive" onclick={() => archiveMessage(msg.filename)}>Archive</button>
										<button class="action-btn delete" onclick={() => deleteMessage(msg.filename)}>Delete</button>
									</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			{#if archives.length > 0}
				<button class="toggle-archives" onclick={() => showArchives = !showArchives}>
					{showArchives ? 'Hide' : 'Show'} archives ({archives.length})
				</button>
				{#if showArchives}
					<div class="messages archives">
						{#each archives as msg}
							<div class="message">
								<button class="message-header" onclick={() => expandedMsg = expandedMsg === msg.filename ? null : msg.filename}>
									<span class="msg-from">From: {msg.from}</span>
									<span class="msg-date">{msg.sentAt ? new Date(msg.sentAt).toLocaleString() : ''}</span>
									<span class="msg-toggle">{expandedMsg === msg.filename ? '▼' : '▶'}</span>
								</button>
								{#if expandedMsg === msg.filename}
									<div class="message-body">
										<pre class="msg-text">{msg.body}</pre>
										<div class="msg-actions">
											<button class="action-btn delete" onclick={() => deleteArchive(msg.filename)}>Delete</button>
										</div>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			{/if}

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
				{#each detail.schedule.events as event, i}
					<div class="event">
						<span class="event-time">{new Date(event.time).toLocaleString()}</span>
						{#if event.title}
							<span class="event-title">{event.title}</span>
						{/if}
						<button class="event-remove" onclick={() => removeEvent(i)} title="Remove">×</button>
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

	.messages { display: flex; flex-direction: column; gap: 0.5rem; }
	.message {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.message-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		width: 100%;
		text-align: left;
		transition: background var(--transition);
		font-size: 0.875rem;
	}
	.message-header:hover { background: var(--bg); }
	.msg-from { font-weight: 600; }
	.msg-date { color: var(--text-muted); font-size: 0.8rem; }
	.msg-project {
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0.06rem 0.4rem;
		border-radius: 99px;
		background: var(--primary-subtle);
		color: var(--primary);
	}
	.msg-rr {
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0.06rem 0.4rem;
		border-radius: 99px;
		background: var(--warning-subtle);
		color: var(--warning);
	}
	.msg-toggle { margin-left: auto; color: var(--text-light); }
	.message-body {
		padding: 0 1rem 1rem;
		border-top: 1px solid var(--border);
	}
	.msg-text {
		font-family: var(--font);
		font-size: 0.875rem;
		line-height: 1.6;
		white-space: pre-wrap;
		word-wrap: break-word;
		padding: 0.75rem 0;
	}
	.msg-actions { display: flex; gap: 0.5rem; }
	.action-btn {
		padding: 0.375rem 0.75rem;
		border-radius: var(--radius);
		font-size: 0.8rem;
		font-weight: 600;
		transition: all var(--transition);
		text-decoration: none;
	}
	.action-btn.reply { background: var(--primary-subtle); color: var(--primary); }
	.action-btn.reply:hover { background: var(--primary); color: var(--on-primary); }
	.action-btn.archive { background: var(--surface); color: var(--text-muted); border: 1px solid var(--border); }
	.action-btn.archive:hover { background: var(--bg); color: var(--text); }
	.action-btn.delete { color: var(--danger); }
	.action-btn.delete:hover { background: var(--danger-subtle); }

	.toggle-archives {
		margin-top: 1rem;
		font-size: 0.8rem;
		color: var(--text-muted);
		padding: 0.375rem 0;
	}
	.toggle-archives:hover { color: var(--text); }
	.archives { margin-top: 0.5rem; opacity: 0.7; }

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
