import { defineConfig } from "vite";

// The example has no special runtime plugins; this file is intentionally small so
// it behaves like a normal Vite application when copied into another project.
export default defineConfig({
  server: { port: 5173 },
  build: { sourcemap: true },
});
