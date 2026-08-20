import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Vite example is an independent package with its own test command.
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
    },
  },
});
