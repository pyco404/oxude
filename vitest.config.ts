import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: false,
    // Many tests build a fresh database and apply every migration. Alone that
    // takes about two seconds; with the whole suite running in parallel it can
    // pass the default five, which failed runs on a timeout rather than a bug.
    testTimeout: 20_000,
    // Each test file runs its own PGlite, which is a whole Postgres compiled to
    // wasm and costs real memory. Unbounded, one worker per file is enough to
    // have the suite killed outright - exit 137, no failing test, nothing to
    // read. Four keeps the wall time (about 150s) and leaves the headroom.
    poolOptions: { threads: { maxThreads: 4, minThreads: 1 } },
  },
});
