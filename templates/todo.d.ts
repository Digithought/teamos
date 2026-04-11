/** A single todo item - only incomplete items are in the todo list */
export interface TodoItem {
  title: string;
  description?: string;
  priority: 'pressing' | 'today' | 'thisWeek' | 'later';
  status?: 'blocked';
  notes?: string;
  projectCode?: string;
}

/** Root structure for todo.json */
export interface TodoList {
  items: TodoItem[];
}
