<script lang="ts">
import { api } from '../lib/api.js';
import type { Project } from '../lib/types.js';

let orgContent = $state('');
let orgDraft = $state('');
let _orgLoading = $state(true);
let _orgSaving = $state(false);
let _orgError = $state('');
const _orgDirty = $derived(orgDraft !== orgContent);

let _projects = $state<Project[]>([]);
let _projectsLoading = $state(true);

let _showNew = $state(false);
let newCode = $state('');
let newName = $state('');
let newDescription = $state('');
let newStatus = $state('active');
let _savingNew = $state(false);
let _newError = $state('');

let editingCode = $state<string | null>(null);
let editName = $state('');
let editDescription = $state('');
let editStatus = $state('active');
let _savingEdit = $state(false);
let _editError = $state('');

async function loadOrg() {
	_orgLoading = true;
	try {
		const { content } = await api.org();
		orgContent = content;
		orgDraft = content;
	} catch (err) {
		_orgError = err instanceof Error ? err.message : 'Failed to load org';
	} finally {
		_orgLoading = false;
	}
}

async function loadProjects() {
	_projectsLoading = true;
	const { projects: p } = await api.projects();
	_projects = p ?? [];
	_projectsLoading = false;
}

async function saveOrg() {
	_orgSaving = true;
	_orgError = '';
	try {
		await api.updateOrg(orgDraft);
		orgContent = orgDraft;
	} catch (err) {
		_orgError = err instanceof Error ? err.message : 'Failed to save';
	} finally {
		_orgSaving = false;
	}
}

function resetOrg() {
	orgDraft = orgContent;
	_orgError = '';
}

function openNew() {
	newCode = '';
	newName = '';
	newDescription = '';
	newStatus = 'active';
	_newError = '';
	_showNew = true;
}

async function saveNew() {
	if (!newCode.trim() || !newName.trim()) return;
	_savingNew = true;
	_newError = '';
	try {
		await api.createProject({
			code: newCode.trim(),
			name: newName.trim(),
			description: newDescription.trim() || undefined,
			status: newStatus.trim() || undefined,
		});
		_showNew = false;
		await loadProjects();
	} catch (err) {
		_newError = err instanceof Error ? err.message : 'Failed to create project';
	} finally {
		_savingNew = false;
	}
}

function startEdit(project: Project) {
	editingCode = project.code;
	editName = project.name;
	editDescription = project.description ?? '';
	editStatus = project.status ?? 'active';
	_editError = '';
}

function cancelEdit() {
	editingCode = null;
	_editError = '';
}

async function saveEdit() {
	if (!editingCode) return;
	_savingEdit = true;
	_editError = '';
	try {
		await api.updateProject(editingCode, {
			name: editName.trim(),
			description: editDescription.trim(),
			status: editStatus.trim(),
		});
		editingCode = null;
		await loadProjects();
	} catch (err) {
		_editError = err instanceof Error ? err.message : 'Failed to update project';
	} finally {
		_savingEdit = false;
	}
}

async function removeProject(code: string) {
	if (!confirm(`Delete project "${code}"?`)) return;
	await api.deleteProject(code);
	await loadProjects();
}

$effect(() => {
	loadOrg();
	loadProjects();
});
</script>

<section class="section">
	<div class="section-header">
		<h2 class="section-title">Org Document</h2>
		<div class="section-actions">
			<button
				class="btn btn-ghost"
				onclick={resetOrg}
				disabled={!orgDirty || orgSaving}
			>Reset</button>
			<button
				class="btn btn-primary"
				onclick={saveOrg}
				disabled={!orgDirty || orgSaving}
			>{orgSaving ? 'Saving...' : 'Save'}</button>
		</div>
	</div>
	{#if orgLoading}
		<div class="loading">Loading...</div>
	{:else}
		{#if orgError}
			<div class="form-error">{orgError}</div>
		{/if}
		<textarea class="org-editor" bind:value={orgDraft} rows="20" spellcheck="false"></textarea>
	{/if}
</section>

<section class="section">
	<div class="section-header">
		<h2 class="section-title">Projects</h2>
		{#if !showNew}
			<button class="new-btn" onclick={openNew}>New Project</button>
		{/if}
	</div>

	{#if showNew}
		<div class="form-card">
			<div class="form-row">
				<div class="form-group" style="flex:1">
					<label class="label" for="new-code">Code</label>
					<input id="new-code" type="text" bind:value={newCode} placeholder="e.g. CORE" />
				</div>
				<div class="form-group" style="flex:2">
					<label class="label" for="new-name">Name</label>
					<input id="new-name" type="text" bind:value={newName} placeholder="Project name" />
				</div>
				<div class="form-group" style="flex:1">
					<label class="label" for="new-status">Status</label>
					<select id="new-status" bind:value={newStatus}>
						<option value="active">active</option>
						<option value="planning">planning</option>
						<option value="paused">paused</option>
						<option value="complete">complete</option>
					</select>
				</div>
			</div>
			<div class="form-group">
				<label class="label" for="new-desc">Description</label>
				<textarea id="new-desc" bind:value={newDescription} rows="2" placeholder="Brief description"></textarea>
			</div>
			{#if newError}
				<div class="form-error">{newError}</div>
			{/if}
			<div class="form-actions">
				<button
					class="btn btn-primary"
					onclick={saveNew}
					disabled={!newCode.trim() || !newName.trim() || savingNew}
				>{savingNew ? 'Creating...' : 'Create Project'}</button>
				<button class="btn btn-ghost" onclick={() => showNew = false}>Cancel</button>
			</div>
		</div>
	{/if}

	{#if projectsLoading}
		<div class="loading">Loading...</div>
	{:else if projects.length === 0 && !showNew}
		<p class="empty">No projects yet.</p>
	{:else}
		<div class="projects">
			{#each projects as project}
				{#if editingCode === project.code}
					<div class="form-card">
						<div class="form-row">
							<div class="form-group" style="flex:1">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="label">Code</label>
								<input type="text" value={project.code} disabled />
							</div>
							<div class="form-group" style="flex:2">
								<label class="label" for="edit-name">Name</label>
								<input id="edit-name" type="text" bind:value={editName} />
							</div>
							<div class="form-group" style="flex:1">
								<label class="label" for="edit-status">Status</label>
								<select id="edit-status" bind:value={editStatus}>
									<option value="active">active</option>
									<option value="planning">planning</option>
									<option value="paused">paused</option>
									<option value="complete">complete</option>
								</select>
							</div>
						</div>
						<div class="form-group">
							<label class="label" for="edit-desc">Description</label>
							<textarea id="edit-desc" bind:value={editDescription} rows="2"></textarea>
						</div>
						{#if editError}
							<div class="form-error">{editError}</div>
						{/if}
						<div class="form-actions">
							<button
								class="btn btn-primary"
								onclick={saveEdit}
								disabled={!editName.trim() || savingEdit}
							>{savingEdit ? 'Saving...' : 'Save'}</button>
							<button class="btn btn-ghost" onclick={cancelEdit}>Cancel</button>
						</div>
					</div>
				{:else}
					<div class="project">
						<div class="project-header">
							<div class="project-title">
								<span class="project-code">{project.code}</span>
								<span class="project-name">{project.name}</span>
								<span class="project-status status-{project.status}">{project.status}</span>
							</div>
							<div class="project-actions">
								<button class="link-btn" onclick={() => startEdit(project)}>Edit</button>
								<button class="link-btn danger" onclick={() => removeProject(project.code)}>Delete</button>
							</div>
						</div>
						{#if project.description}
							<p class="project-desc">{project.description}</p>
						{/if}
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</section>

<style>
	.section { margin-bottom: 2rem; }
	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.75rem;
	}
	.section-actions { display: flex; align-items: center; gap: 0.5rem; }
	.section-title {
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	.loading { padding: 1rem; color: var(--text-muted); font-size: 0.875rem; }
	.empty { font-size: 0.875rem; color: var(--text-muted); }
	.org-editor {
		width: 100%;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
		line-height: 1.5;
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		resize: vertical;
	}
	.form-error {
		font-size: 0.8rem;
		color: var(--danger);
		padding: 0.5rem 0.75rem;
		background: var(--danger-subtle);
		border-radius: var(--radius);
		margin-bottom: 0.5rem;
	}
	.form-card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
		margin-bottom: 0.75rem;
	}
	.form-card .form-row { display: flex; gap: 1rem; }
	.form-card .form-group { margin-bottom: 0.75rem; }
	.form-card .label {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-muted);
		margin-bottom: 0.375rem;
	}
	.form-card input, .form-card select, .form-card textarea { width: 100%; }
	.form-card input:disabled { opacity: 0.6; }
	.form-actions { display: flex; gap: 0.75rem; margin-top: 0.25rem; }
	.projects { display: flex; flex-direction: column; gap: 0.5rem; }
	.project {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.875rem 1rem;
	}
	.project-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.project-title { display: flex; align-items: center; gap: 0.625rem; flex-wrap: wrap; }
	.project-code {
		font-size: 0.75rem;
		font-weight: 700;
		padding: 0.15rem 0.5rem;
		border-radius: 99px;
		background: var(--primary-subtle);
		color: var(--primary);
		letter-spacing: 0.02em;
	}
	.project-name { font-weight: 600; font-size: 0.925rem; }
	.project-status {
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		padding: 0.125rem 0.5rem;
		border-radius: 99px;
		background: var(--bg);
		color: var(--text-muted);
		border: 1px solid var(--border);
	}
	.project-status.status-active { color: var(--primary); border-color: var(--primary); }
	.project-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
	.link-btn {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.2rem 0.5rem;
		border-radius: var(--radius);
		color: var(--text-muted);
		border: 1px solid var(--border);
		background: transparent;
		transition: all var(--transition);
	}
	.link-btn:hover { background: var(--bg); color: var(--text); }
	.link-btn.danger:hover { color: var(--danger); border-color: var(--danger); }
	.project-desc {
		font-size: 0.85rem;
		color: var(--text-muted);
		margin: 0.5rem 0 0;
		line-height: 1.5;
	}
	.new-btn {
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--primary);
		border-radius: var(--radius);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--primary);
		background: transparent;
		transition: all var(--transition);
	}
	.new-btn:hover { background: var(--primary); color: var(--on-primary); }
	.btn {
		padding: 0.5rem 1rem;
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.8rem;
		transition: all var(--transition);
	}
	.btn-primary { background: var(--primary); color: var(--on-primary); }
	.btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { color: var(--text-muted); }
	.btn-ghost:hover:not(:disabled) { background: var(--bg); color: var(--text); }
	.btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
