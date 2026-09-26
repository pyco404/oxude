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
    // read. Four keeps the wall time and leaves the headroom.
    //
    // Under `forks`, which is vitest's default pool and the one this suite
    // actually runs on. This was written as `threads` and so did nothing at
    // all: the cap sat under a pool that was never selected, the suite kept
    // taking one fork per core, and exit 137 went on happening - the exact
    // thing the cap was added to stop. If you set `pool` here, move this with
    // it, or it goes quiet again.
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
