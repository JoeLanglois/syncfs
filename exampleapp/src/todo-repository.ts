import { SyncKv } from "@synckv/client";

export interface TodoList {
  id: string;
  name: string;
  createdAt: string;
}

export interface Todo {
  id: string;
  listId: string;
  title: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

const ROOT = "todo/";
const LISTS = `${ROOT}lists/`;
const ITEMS = `${ROOT}items/`;

/**
 * Maps the app's records onto SyncKv. Every record has one independent key,
 * so records have independent hashes and conflict boundaries.
 */
export class TodoRepository {
  constructor(readonly kv: SyncKv) {}

  async initialize(): Promise<void> {
    // The whole todo key prefix is available offline and synchronized in background.
    await this.kv.sync(ROOT);
    // Wait for the first pull before deciding whether to create a default list.
    // If the server is offline we deliberately continue with the local replica;
    // the queued default value will synchronize when connectivity returns.
    try {
      await this.kv.synchronize();
    } catch {
      // Background synchronization reports the network error through SyncKv.onError.
    }
    if ((await this.lists()).length === 0) await this.createList("My Todos");
  }

  async lists(): Promise<TodoList[]> {
    const records = await this.readPrefix<TodoList>(LISTS);
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async todos(listId: string): Promise<Todo[]> {
    const records = await this.readPrefix<Todo>(ITEMS);
    return records
      .filter((todo) => todo.listId === listId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createList(name: string): Promise<TodoList> {
    const existing = await this.lists();
    const list: TodoList = {
      id: crypto.randomUUID(),
      name: requiredText(name, "List name"),
      createdAt: nextTimestamp(existing),
    };
    await this.kv.set(this.listKey(list.id), list);
    return list;
  }

  async renameList(list: TodoList, name: string): Promise<TodoList> {
    const updated = { ...list, name: requiredText(name, "List name") };
    await this.kv.set(this.listKey(list.id), updated);
    return updated;
  }

  async deleteList(id: string): Promise<void> {
    const items = await this.todos(id);
    // The list and all of its todos disappear in one local and remote transaction.
    await this.kv.transaction((tx) => {
      for (const todo of items) tx.delete(this.todoKey(todo.id));
      tx.delete(this.listKey(id));
    });
  }

  async createTodo(listId: string, title: string): Promise<Todo> {
    // Millisecond clocks can tie during fast input or tests. Advancing past the
    // newest value gives the UI a stable creation order without a central index.
    const now = nextTimestamp(await this.todos(listId));
    const todo: Todo = {
      id: crypto.randomUUID(),
      listId,
      title: requiredText(title, "Todo title"),
      completed: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.kv.set(this.todoKey(todo.id), todo);
    return todo;
  }

  async updateTodo(todo: Todo, changes: Partial<Pick<Todo, "title" | "completed">>): Promise<Todo> {
    const updated: Todo = {
      ...todo,
      ...changes,
      title: changes.title === undefined ? todo.title : requiredText(changes.title, "Todo title"),
      updatedAt: new Date().toISOString(),
    };
    await this.kv.set(this.todoKey(todo.id), updated);
    return updated;
  }

  async deleteTodo(id: string): Promise<void> {
    await this.kv.delete(this.todoKey(id));
  }

  async setAllCompleted(todos: readonly Todo[], completed: boolean): Promise<void> {
    const updatedAt = new Date().toISOString();
    await this.kv.transaction((tx) => {
      for (const todo of todos) {
        tx.set(this.todoKey(todo.id), { ...todo, completed, updatedAt });
      }
    });
  }

  async clearCompleted(todos: readonly Todo[]): Promise<void> {
    await this.kv.transaction((tx) => {
      for (const todo of todos) {
        if (todo.completed) tx.delete(this.todoKey(todo.id));
      }
    });
  }

  private async readPrefix<T>(prefix: string): Promise<T[]> {
    const keys = await this.kv.keys(prefix);
    return Promise.all(keys.map((key) => this.kv.get<T>(key)));
  }

  private listKey(id: string): string {
    return `${LISTS}${id}`;
  }

  private todoKey(id: string): string {
    return `${ITEMS}${id}`;
  }
}

function nextTimestamp(records: readonly { createdAt: string }[]): string {
  const newest = records.reduce((maximum, record) => Math.max(maximum, Date.parse(record.createdAt)), 0);
  return new Date(Math.max(Date.now(), newest + 1)).toISOString();
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${label} cannot be empty`);
  return trimmed;
}
