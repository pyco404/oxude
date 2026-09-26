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
runs against a server you already have instead.

**`npm run check` runs it.** It used to not, and `test/postgres.test.ts` skips
itself without `PG_URL`, so a failure in it could sit in the tree looking like
a pass — which is exactly what happened: a sweep that changed who stakes left a
broken case here, and nothing that ran routinely would have said so. A gate
that quietly omits a path is not a gate. So `check` is
`typecheck && test:pg && test`, cheapest first, and it **fails** rather than
skips when there is no Postgres to run against.

A bare `npx vitest run` still skips the file; its describe block says so in its
own name. `npm run check` is the thing to trust before a commit or a deploy.

## The gate, and the two paths that need more than Node

`npm run check` is `typecheck && test:pg && test:chain && test` — cheapest
first, so a driver disagreement surfaces in seconds and a program bug in a
minute, rather than after the four-minute suite. Both of the extra paths used
to be outside it, and both are where a units or flow bug hides: they are the
only places the real Postgres driver and the real bytecode are exercised.

They fail differently on purpose:

| | missing prerequisite | why |
| --- | --- | --- |
| `test:pg` | **fails** | Postgres is one `apt install`. Every raw-SQL bigint depends on it. |
| `test:chain` | **skips, loudly** | The Solana toolchain plus a built program is a much larger ask, and someone working on the web app or the engine should not be stopped by it. |

The chain skip prints what is missing and how to get it, so it can never read
as a pass, and `CHAIN_REQUIRED=1 npm run test:chain` turns it into a failure
for anywhere that should have the toolchain.

`scripts/chain-test.sh` also **warns when the `.so` is older than the Rust
sources** — tests passing against bytecode nobody is going to ship is exactly
the quiet failure the gate exists to prevent. A warning rather than a refusal,
because a comment-only edit moves the source and not the binary, and stopping
the suite for that would teach people to skip it. If you changed anything but
comments, run `npm run chain:build` first.

The rest of the suite **cannot** be pointed at Postgres as it stands: tests call
`connect()` expecting a fresh empty database, which is true of PGlite and false
of a shared server. Fixing that means a database per `connect()`, which nothing
needs yet.
