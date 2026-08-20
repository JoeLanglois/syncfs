import { createApp } from "./app.ts";

function argument(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  return index < 0 ? undefined : Deno.args[index + 1];
}

const port = Number(argument("--port") ?? Deno.env.get("PORT") ?? 8787);
const hostname = argument("--hostname") ?? Deno.env.get("HOST") ?? "0.0.0.0";
const database = argument("--db") ?? Deno.env.get("DATABASE_PATH") ?? "./data/synckv.sqlite";
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port: ${port}`);

// SQLite creates the file but not its parent directory.
if (database !== ":memory:") {
  const separator = Math.max(database.lastIndexOf("/"), database.lastIndexOf("\\"));
  if (separator >= 0) await Deno.mkdir(database.slice(0, separator), { recursive: true });
}

const app = createApp(database);
const abort = new AbortController();
const server = Deno.serve({
  port,
  hostname,
  signal: abort.signal,
  onListen: ({ hostname: boundHost, port: boundPort }) => {
    // A machine-readable line lets integration tests discover an ephemeral port.
    console.log(JSON.stringify({ event: "listening", hostname: boundHost, port: boundPort }));
  },
}, app.fetch);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => abort.abort());
}

await server.finished;
app.close();
