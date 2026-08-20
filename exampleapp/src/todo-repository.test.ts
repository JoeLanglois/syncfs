import "fake-indexeddb/auto";
import { SyncKv } from "@synckv/client";
import { afterEach, describe, expect, it } from "vitest";
import { TodoRepository } from "./todo-repository.js";

const stores: SyncKv[] = [];

function createRepository(): TodoRepository {
  const store = new SyncKv({ dbName: `todo-test-${crypto.randomUUID()}`, syncIntervalMs: 0 });
  stores.push(store);
  return new TodoRepository(store);
}

afterEach(async () => Promise.all(stores.splice(0).map((store) => store.close())));

describe("TodoRepository", () => {
  it("creates a default list and stores every record under an individual key", async () => {
    const repository = createRepository();
    await repository.initialize();
    const [list] = await repository.lists();
    expect(list?.name).toBe("My Todos");

    const first = await repository.createTodo(list!.id, "First task");
    const second = await repository.createTodo(list!.id, "Second task");
    expect(await repository.todos(list!.id)).toEqual([first, second]);

    const listKeys = await repository.kv.keys("todo/lists/");
    const itemKeys = await repository.kv.keys("todo/items/");
    expect(listKeys).toHaveLength(1);
    expect(itemKeys.sort()).toEqual([
      `todo/items/${first.id}`,
      `todo/items/${second.id}`,
    ].sort());
  });

  it("updates, completes, clears, renames, and deletes lists", async () => {
    const repository = createRepository();
    await repository.initialize();
    const firstList = (await repository.lists())[0]!;
    const secondList = await repository.createList("Work");
    const renamed = await repository.renameList(secondList, "Projects");
    expect(renamed.name).toBe("Projects");

    const first = await repository.createTodo(firstList.id, "One");
    const second = await repository.createTodo(firstList.id, "Two");
    await repository.setAllCompleted([first, second], true);
    const completed = await repository.todos(firstList.id);
    expect(completed.every((todo) => todo.completed)).toBe(true);

    await repository.clearCompleted(completed);
    expect(await repository.todos(firstList.id)).toEqual([]);
    await repository.createTodo(renamed.id, "Deleted with list");
    await repository.deleteList(renamed.id);
    expect((await repository.lists()).map((list) => list.id)).not.toContain(renamed.id);
    expect(await repository.todos(renamed.id)).toEqual([]);
  });

  it("rejects blank names and persists across repository instances", async () => {
    const dbName = `todo-persist-${crypto.randomUUID()}`;
    const firstStore = new SyncKv({ dbName, syncIntervalMs: 0 });
    const first = new TodoRepository(firstStore);
    await first.initialize();
    const list = (await first.lists())[0]!;
    await first.createTodo(list.id, "Persistent");
    await expect(first.createTodo(list.id, "   ")).rejects.toBeInstanceOf(TypeError);
    await firstStore.close();

    const secondStore = new SyncKv({ dbName, syncIntervalMs: 0 });
    stores.push(secondStore);
    const second = new TodoRepository(secondStore);
    await second.initialize();
    expect((await second.todos(list.id))[0]?.title).toBe("Persistent");
  });
});
