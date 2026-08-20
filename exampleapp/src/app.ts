import m from "mithril";
import type { Todo, TodoList, TodoRepository } from "./todo-repository.js";

type Filter = "all" | "active" | "completed";

interface AppState {
  lists: TodoList[];
  todos: Todo[];
  selectedListId?: string;
  filter: Filter;
  loading: boolean;
  saving: boolean;
  error?: string;
  editingTodoId?: string;
  editTitle: string;
}

/** Create one component instance around a repository to keep rendering testable. */
export function createApp(repository: TodoRepository, syncServerUrl: string): m.Component {
  let stopRemoteWatch: (() => void) | undefined;
  let remoteReloadTimer: ReturnType<typeof setTimeout> | undefined;
  const state: AppState = {
    lists: [],
    todos: [],
    filter: "all",
    loading: true,
    saving: false,
    editTitle: "",
  };

  async function reload(preferredListId = state.selectedListId): Promise<void> {
    state.lists = await repository.lists();
    const selected = state.lists.find((list) => list.id === preferredListId) ?? state.lists[0];
    state.selectedListId = selected?.id;
    state.todos = selected ? await repository.todos(selected.id) : [];
  }

  async function run(operation: () => Promise<void>): Promise<void> {
    state.saving = true;
    state.error = undefined;
    try {
      await operation();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.saving = false;
      m.redraw();
    }
  }

  function visibleTodos(): Todo[] {
    if (state.filter === "active") return state.todos.filter((todo) => !todo.completed);
    if (state.filter === "completed") return state.todos.filter((todo) => todo.completed);
    return state.todos;
  }

  function selectList(id: string): void {
    void run(async () => reload(id));
  }

  function addTodo(input: HTMLInputElement): void {
    const title = input.value.trim();
    if (!title || !state.selectedListId) return;
    void run(async () => {
      await repository.createTodo(state.selectedListId!, title);
      input.value = "";
      await reload();
    });
  }

  function beginEditing(todo: Todo): void {
    state.editingTodoId = todo.id;
    state.editTitle = todo.title;
  }

  function saveEditing(todo: Todo): void {
    // Enter can remove the input and consequently fire blur; only commit once.
    if (state.editingTodoId !== todo.id) return;
    const title = state.editTitle.trim();
    state.editingTodoId = undefined;
    if (!title) {
      void run(async () => {
        await repository.deleteTodo(todo.id);
        await reload();
      });
      return;
    }
    if (title !== todo.title) {
      void run(async () => {
        await repository.updateTodo(todo, { title });
        await reload();
      });
    }
  }

  return {
    oninit(): void {
      void run(async () => {
        try {
          await repository.initialize();
          await reload();
          // SyncKv delivers both server pulls and committed writes from other tabs.
          // Debouncing also makes the harmless notification from our own edit cheap.
          stopRemoteWatch = repository.kv.watch("todo/", () => {
            if (remoteReloadTimer !== undefined) clearTimeout(remoteReloadTimer);
            remoteReloadTimer = setTimeout(() => void run(() => reload()), 50);
          });
        } finally {
          // An unreachable server should show its error instead of an endless loader.
          state.loading = false;
        }
      });
    },

    onremove(): void {
      stopRemoteWatch?.();
      if (remoteReloadTimer !== undefined) clearTimeout(remoteReloadTimer);
    },

    view(): m.Children {
      if (state.loading) return m("section.loading", "Opening your local store…");

      const selectedList = state.lists.find((list) => list.id === state.selectedListId);
      const activeCount = state.todos.filter((todo) => !todo.completed).length;
      const completeCount = state.todos.length - activeCount;
      const displayed = visibleTodos();

      return m(".app-shell", [
        m("aside.sidebar", [
          m("h1.brand", [m("span.logo", "✓"), " SyncKv Todos"]),
          m("p.local-badge", {
            title: `Server: ${syncServerUrl}`,
          }, "● Local-first · syncing to server"),
          m("h2", "Lists"),
          m("nav.list-nav", state.lists.map((list) =>
            m("button.list-button", {
              class: list.id === state.selectedListId ? "selected" : "",
              type: "button",
              onclick: () => selectList(list.id),
            }, list.name),
          )),
          m("form.new-list", {
            onsubmit: (event: SubmitEvent) => {
              event.preventDefault();
              const form = event.currentTarget as HTMLFormElement;
              const input = form.elements.namedItem("listName") as HTMLInputElement;
              if (!input.value.trim()) return;
              void run(async () => {
                const list = await repository.createList(input.value);
                form.reset();
                await reload(list.id);
              });
            },
          }, [
            m("input", { name: "listName", placeholder: "New list", "aria-label": "New list name" }),
            m("button", { type: "submit", title: "Add list" }, "+"),
          ]),
        ]),

        m("main.todoapp", [
          state.error && m(".error", { role: "alert" }, [state.error, m("button", { onclick: () => { state.error = undefined; } }, "×")]),
          selectedList ? [
            m("header.header", [
              m("input.list-title", {
                value: selectedList.name,
                "aria-label": "List name",
                onchange: (event: Event) => {
                  const name = (event.currentTarget as HTMLInputElement).value;
                  void run(async () => {
                    await repository.renameList(selectedList, name);
                    await reload();
                  });
                },
              }),
              state.lists.length > 1 && m("button.delete-list", {
                type: "button",
                title: "Delete this list",
                onclick: () => {
                  if (!confirm(`Delete “${selectedList.name}” and all its todos?`)) return;
                  void run(async () => {
                    await repository.deleteList(selectedList.id);
                    await reload(undefined);
                  });
                },
              }, "Delete list"),
              m("input.new-todo", {
                placeholder: "What needs to be done?",
                "aria-label": "New todo",
                autofocus: true,
                disabled: state.saving,
                onkeydown: (event: KeyboardEvent) => {
                  if (event.key === "Enter") addTodo(event.currentTarget as HTMLInputElement);
                },
              }),
            ]),
            state.todos.length > 0 && m("section.main", [
              m("input.toggle-all", {
                id: "toggle-all",
                type: "checkbox",
                checked: activeCount === 0,
                onchange: (event: Event) => void run(async () => {
                  await repository.setAllCompleted(state.todos, (event.currentTarget as HTMLInputElement).checked);
                  await reload();
                }),
              }),
              m("label", { for: "toggle-all", title: "Toggle all todos" }, "❯"),
              m("ul.todo-list", displayed.map((todo) =>
                m("li", { class: `${todo.completed ? "completed" : ""} ${state.editingTodoId === todo.id ? "editing" : ""}` }, [
                  m(".view", [
                    m("input.toggle", {
                      type: "checkbox",
                      checked: todo.completed,
                      "aria-label": `Mark ${todo.title} complete`,
                      onchange: (event: Event) => void run(async () => {
                        await repository.updateTodo(todo, { completed: (event.currentTarget as HTMLInputElement).checked });
                        await reload();
                      }),
                    }),
                    m("label", { ondblclick: () => beginEditing(todo) }, todo.title),
                    m("button.destroy", {
                      type: "button",
                      "aria-label": `Delete ${todo.title}`,
                      onclick: () => void run(async () => {
                        await repository.deleteTodo(todo.id);
                        await reload();
                      }),
                    }, "×"),
                  ]),
                  state.editingTodoId === todo.id && m("input.edit", {
                    value: state.editTitle,
                    oncreate: ({ dom }) => (dom as HTMLInputElement).focus(),
                    oninput: (event: InputEvent) => { state.editTitle = (event.currentTarget as HTMLInputElement).value; },
                    onblur: () => saveEditing(todo),
                    onkeydown: (event: KeyboardEvent) => {
                      if (event.key === "Enter") saveEditing(todo);
                      if (event.key === "Escape") state.editingTodoId = undefined;
                    },
                  }),
                ]),
              )),
            ]),
            m("footer.footer", [
              m("span.todo-count", [m("strong", String(activeCount)), ` item${activeCount === 1 ? "" : "s"} left`]),
              m("ul.filters", (["all", "active", "completed"] as const).map((filter) =>
                m("li", m("button", {
                  class: state.filter === filter ? "selected" : "",
                  onclick: () => { state.filter = filter; },
                }, filter[0]!.toUpperCase() + filter.slice(1))),
              )),
              completeCount > 0 && m("button.clear-completed", {
                onclick: () => void run(async () => {
                  await repository.clearCompleted(state.todos);
                  await reload();
                }),
              }, "Clear completed"),
            ]),
          ] : m("p.empty", "Create a list to get started."),
        ]),
      ]);
    },
  };
}
