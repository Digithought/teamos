/**
 * @typedef {Object} TodoItem
 * @property {string} id
 * @property {string} title
 * @property {string} [description]
 * @property {'pressing'|'today'|'thisWeek'|'later'} priority
 * @property {'blocked'} [status]
 * @property {string} [notes]
 * @property {string} [projectCode]
 */

/**
 * @typedef {Object} TasksAdapter
 * @property {(member: string) => Promise<TodoItem[]>} listTodos
 * @property {(member: string, input: { title: string, priority: string, description?: string, notes?: string, projectCode?: string, status?: 'blocked' }) => Promise<{ id: string }>} addTodo
 * @property {(member: string, id: string, patch: { title?: string, description?: string, priority?: string, notes?: string, projectCode?: string, status?: 'blocked' | null }) => Promise<void>} updateTodo
 * @property {(member: string, id: string) => Promise<void>} completeTodo
 * @property {(member: string, priority: string) => Promise<boolean>} hasActionableTodos
 */

import { FileTasksAdapter } from './file.mjs';

/**
 * Create a tasks adapter based on configuration.
 *
 * Currently only the file adapter ships; see teamos/docs/tasks.md for the
 * MCP contract a future GitHub Issues / Linear / Jira adapter would implement.
 */
export async function createTasksAdapter(adapterName, _config, teamDir) {
	switch (adapterName) {
		case 'file':
			return new FileTasksAdapter(teamDir);
		default:
			throw new Error(`Unknown tasks adapter: ${adapterName}. Available: file`);
	}
}
