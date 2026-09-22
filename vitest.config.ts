import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: false,
    // Many tests build a fresh database and apply every migration. Alone that
    // takes about two seconds; with the whole suite running in parallel it can
    // pass the default five, which failed runs on a timeout rather than a bug.
    testTimeout: 20_000,
  },
});
