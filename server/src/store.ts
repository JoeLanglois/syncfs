import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "./path.ts";

type Row = Record<string, unknown>;
export interface Conditions { ifMatch?: string; ifNoneMatch?: string }
export interface StoredResult { status: number; body: Record<string, unknown> }
export type TransactionOperation =
  | { type: "set"; key: string; value: unknown; baseEtag?: string }
  | { type: "delete"; key: string; baseEtag?: string };

/** SQLite persistence for one shared key space. Values are stored as JSON text. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        etag TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv_mutations (
        idempotency_key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        status INTEGER NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        origin_client_id TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  get(key: string): { value: unknown; etag: string } {
    const row = this.db.prepare("SELECT value, etag FROM kv WHERE key = ?").get(key) as Row | undefined;
    if (!row) throw new HttpError(404, `Key not found: ${key}`);
    return { value: JSON.parse(String(row.value)), etag: String(row.etag) };
  }

  getMany(keys: readonly string[]): Array<{ key: string; value: unknown; etag: string }> {
    return keys.map((key) => ({ key, ...this.get(key) }));
  }

  /** Return every key under a raw string prefix and a hash of the complete listing. */
  list(prefix: string): { entries: Array<{ key: string; etag: string }>; etag: string } {
    const entries = (this.db.prepare("SELECT key, etag FROM kv ORDER BY key").all() as Row[])
      .map((row) => ({ key: String(row.key), etag: String(row.etag) }))
      .filter((entry) => entry.key.startsWith(prefix));
    return { entries, etag: hash(JSON.stringify(entries)) };
  }

  set(
    key: string,
    value: unknown,
    conditions: Conditions,
    idempotencyKey: string,
    originClientId?: string,
  ): StoredResult {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new HttpError(400, "Value is not JSON serializable");
    const fingerprint = `SET\n${key}\n${conditions.ifMatch ?? ""}\n${conditions.ifNoneMatch ?? ""}\n${serialized}`;
    return this.mutate(idempotencyKey, fingerprint, () => {
      const current = this.etag(key);
      checkConditions(key, current, conditions, true);
      const etag = hash(serialized);
      this.db.prepare(`
        INSERT INTO kv(key, value, etag, updated_at) VALUES(?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, etag=excluded.etag,
          updated_at=excluded.updated_at
      `).run(key, serialized, etag, new Date().toISOString());
      this.recordChange(key, originClientId);
      return { status: 200, body: { etag } };
    });
  }

  delete(
    key: string,
    conditions: Conditions,
    idempotencyKey: string,
    originClientId?: string,
  ): StoredResult {
    const fingerprint = `DELETE\n${key}\n${conditions.ifMatch ?? ""}\n${conditions.ifNoneMatch ?? ""}`;
    return this.mutate(idempotencyKey, fingerprint, () => {
      const current = this.etag(key);
      if (!current) throw new HttpError(404, `Key not found: ${key}`);
      checkConditions(key, current, conditions, false);
      this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
      this.recordChange(key, originClientId);
      return { status: 200, body: {} };
    });
  }

  /** Check and apply every operation inside the same SQLite transaction. */
  transaction(
    operations: readonly TransactionOperation[],
    idempotencyKey: string,
    originClientId?: string,
  ): StoredResult {
    const fingerprint = `TRANSACTION\n${JSON.stringify(operations)}`;
    return this.mutate(idempotencyKey, fingerprint, () => {
      const prepared = operations.map((operation) => {
        const current = this.etag(operation.key);
        checkConditions(
          operation.key,
          current,
          operation.baseEtag ? { ifMatch: operation.baseEtag } : { ifNoneMatch: "*" },
          operation.type === "set",
        );
        if (operation.type === "delete") {
          if (!current) throw new HttpError(404, `Key not found: ${operation.key}`);
          return { ...operation, serialized: undefined, etag: null };
        }
        const serialized = JSON.stringify(operation.value);
        if (serialized === undefined) throw new HttpError(400, "Value is not JSON serializable");
        return { ...operation, serialized, etag: hash(serialized) };
      });

      const etags: Record<string, string | null> = {};
      for (const operation of prepared) {
        if (operation.type === "delete") {
          this.db.prepare("DELETE FROM kv WHERE key = ?").run(operation.key);
          etags[operation.key] = null;
        } else {
          this.db.prepare(`
            INSERT INTO kv(key, value, etag, updated_at) VALUES(?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, etag=excluded.etag,
              updated_at=excluded.updated_at
          `).run(operation.key, operation.serialized, operation.etag, new Date().toISOString());
          etags[operation.key] = operation.etag;
        }
        this.recordChange(operation.key, originClientId);
      }
      return { status: 200, body: { etags } };
    });
  }

  changesAfter(id: number): Array<{ id: number; key: string; originClientId?: string }> {
    return (this.db.prepare(
      "SELECT id, key, origin_client_id FROM kv_changes WHERE id > ? ORDER BY id LIMIT 1000",
    ).all(id) as Row[]).map((row) => ({
      id: Number(row.id),
      key: String(row.key),
      ...(row.origin_client_id ? { originClientId: String(row.origin_client_id) } : {}),
    }));
  }

  latestChangeId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM kv_changes").get() as Row;
    return Number(row.id);
  }

  private mutate(key: string, fingerprint: string, operation: () => StoredResult): StoredResult {
    const prior = this.db.prepare(
      "SELECT fingerprint, status, response FROM kv_mutations WHERE idempotency_key = ?",
    ).get(key) as Row | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new HttpError(409, "Idempotency key reused");
      return { status: Number(prior.status), body: JSON.parse(String(prior.response)) };
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.prepare(`
        INSERT INTO kv_mutations(idempotency_key, fingerprint, status, response, created_at)
        VALUES(?, ?, ?, ?, ?)
      `).run(key, fingerprint, result.status, JSON.stringify(result.body), new Date().toISOString());
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private etag(key: string): string | undefined {
    const row = this.db.prepare("SELECT etag FROM kv WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.etag) : undefined;
  }

  private recordChange(key: string, origin?: string): void {
    this.db.prepare("INSERT INTO kv_changes(key, origin_client_id, created_at) VALUES(?, ?, ?)")
      .run(key, origin ?? null, new Date().toISOString());
  }
}

function checkConditions(key: string, current: string | undefined, conditions: Conditions, creating: boolean): void {
  if (!current) {
    if (conditions.ifMatch) throw new HttpError(412, `Key no longer exists: ${key}`);
    if (creating && conditions.ifNoneMatch !== "*") throw new HttpError(428, "Create requires If-None-Match: *");
    return;
  }
  if (creating && conditions.ifNoneMatch === "*") throw new HttpError(412, `Key already exists: ${key}`);
  if (conditions.ifMatch && conditions.ifMatch !== current) throw new HttpError(412, `ETag conflict: ${key}`);
  if (!conditions.ifMatch && !conditions.ifNoneMatch) throw new HttpError(428, "Mutation requires a precondition");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
