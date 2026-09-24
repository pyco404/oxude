# Working in this repository

## Commits

Commit in small logical commits, not one big commit per task.

- **One understandable thing per commit.** Split a task into as many commits as it
  naturally has steps: a schema change, the code that uses it, the UI that shows it,
  the docs that describe it.
- **Every commit leaves the build and tests passing.** Run `npm run check` (and
  `npm run typecheck` in `web/` for web changes) before each commit.
- **Never split a change that only works as a whole.** If two files have to change
  together for the build or tests to pass, they go in one commit. A test that
  covers new code goes in the same commit as that code, or after it, never before.
- **Message format: `area: what changed`**, lower case, imperative, e.g.
  `autoplay: add floor pause`, `house: pair exhibitions within a band`,
  `docs: record the chip rate`. A body is welcome when the why isn't obvious.

Commit locally; push only when asked.

## Databases: the tests are not the production driver

The suite runs on **PGlite**; production runs on **node-postgres**. They do not
agree about `int8`, and the difference is silent:

- PGlite hands a bigint back as a **number**.
- node-postgres hands it back as a **string**, because an int8 can hold more
  than a JavaScript number can.

Through a typed drizzle column this is invisible — drizzle coerces either way.
Through **raw SQL** it is not, so a `sum(...)::bigint` that reads correctly in
every test can come back as `"900000000"` in production. `src/db/client.ts`
installs a type parser so the two agree, and it throws rather than silently
losing digits above `Number.MAX_SAFE_INTEGER`.

**So: any raw SQL that returns a bigint has to be verified against real
Postgres.** Add a case to `test/postgres.test.ts` and run:

```bash
npm run test:pg        # starts a throwaway cluster, runs it, removes it
```

It needs no docker and no root — it uses the postgres binaries already on the
machine and never touches the machine's own server. `PG_URL=postgres://...`
runs against a server you already have instead. The file skips itself when
`PG_URL` is unset, so `npm run check` stays offline.

The rest of the suite **cannot** be pointed at Postgres as it stands: tests call
`connect()` expecting a fresh empty database, which is true of PGlite and false
of a shared server. Fixing that means a database per `connect()`, which nothing
needs yet.
