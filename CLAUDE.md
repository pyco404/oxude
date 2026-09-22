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
