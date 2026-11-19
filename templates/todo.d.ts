import type { Effort } from './effort';

/** A single todo item - only incomplete items are in the todo list */
export interface TodoItem {
	title: string;
	description?: string;
	priority: 'pressing' | 'today' | 'thisWeek' | 'later';
	status?: 'blocked';
	notes?: string;
	projectCode?: string;
	/** Effort for the cycle that handles this item; absent means the member's. */
	effort?: Effort;
}

/** Root structure for todo.json */
export interface TodoList {
	items: TodoItem[];
}
