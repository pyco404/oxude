# Plugging LLM players into the match engine

The engine never learns that an agent is an LLM. An agent is a function from a
view to an action, and that is the whole contract:

```ts
type Agent = (view: View) => Action; // "fold" | "call" | "raise"
```

Everything below keeps that contract. The isolation guarantee is structural:
`View` has no opponent-edge field, and the engine builds views through
`exactView`, which makes an extra property a compile error. A prompt can only
leak what the view carries.

## Two ways in, for two different jobs

### 1. Policy agents — for rating, balance and the exact calculator

The model is asked, once, to fill in a decision table: what it would do for
each of the five edges, in each situation (acting first, under pressure after
an opponent raise, facing a raise). The table is wrapped as an ordinary pure
`Agent`.

```ts
// src/agents/policy.ts
export type Policy = Record<Situation, Record<Edge, Action>>; // 3 x 5 entries

export function policyAgent(policy: Policy): Agent {
  return (view) => policy[situationOf(view)][edgeKey(view.myEdge)];
}

// The model returns a Policy (structured output), validated before use.
export async function elicitPolicy(model: Model, brief: string): Promise<Policy>;
```

Why this mode matters: a policy agent is deterministic and pure, so
`expectedNet` rates it **exactly**, with no sampling noise, exactly as it rates
`Reckless` or a probe. An LLM player gets a real number on the same scale as
the presets, and the same ship criteria apply to it. It also costs one model
call per match instead of one per decision.

It is genuinely weaker than deciding in the moment: the table cannot use the
running score, the round number or the opponent's raise history unless those
are added as table dimensions. Keep the table small; every dimension multiplies
the number of cells the model has to fill.

### 2. Live agents — for real matches

For a match where the model decides in the moment, the only thing missing is
`await`:

```ts
type AsyncAgent = (view: View) => Promise<Action>;
```

The round logic must not be duplicated for it. Today `decideRound` both asks
the agents and knows the turn-based sequence. Split those: keep the sequence in
one place as a script that yields requests and receives actions, and let a sync
driver and an async driver consume the same script.

```ts
// src/round.ts (sketch)
export function* roundScript(state, edges, stakes): Generator<AskRequest, Decision, Action> {
  const first = yield { seat: leader, mine: null, opp: null };
  // ... one raise per round, fold-or-call answer, exactly as now
}
```

`playMatch` drives it with `agent(view)`; `playMatchAsync` drives the same
generator with `await agent(view)`. The rules live in one place, so the sync
engine, the async engine and the exact calculator cannot drift — the same
reason `round.ts` exists at all.

## Determinism, replay and disputes

The engine's randomness stays seeded, so the deal and the flips replay exactly.
Model output does not. For a betting product the transcript is the record:

- **Log every decision** as it was made: seat, round, the view shown, the raw
  response, the parsed action, model id, prompt hash, latency, tokens, cost.
- **Replay from the log, not the model.** `replayAgent(log, seat)` is a pure
  `Agent` that returns the recorded actions in order. Re-running a finished
  match with the same seed and two replay agents must reproduce the log
  byte-for-byte. That check belongs in the test suite, and it is what settles a
  dispute about what happened.
- **Rate with policies, settle with replays.** Exact ratings need mode 1; match
  history needs mode 2 plus replay.

## Making a model's answer safe to use

- **Constrain the output.** Ask for one of three tokens via structured output or
  a tool call; parse, then validate against `Action`. The engine already throws
  on anything else (`agent A returned invalid action`), which would abort a
  match mid-way.
- **Always have a fallback.** On an invalid answer, a timeout or an API error,
  fall back to a named preset (a pot-odds strategy is the honest default), and
  record in the log that the fallback was used and why. A match must never hang
  on a model.
- **Budget per match.** At most 3 rounds and at most 3 decisions per round, so a
  live agent makes at most 5 calls a match. Cap retries at one.
- **Cache by prompt hash.** Same model plus same prompt returns the cached
  action. This cuts cost, and makes a re-run of a match far more likely to
  reproduce.

## Keeping the isolation guarantee honest

The type system stops the engine from handing over an opponent's edge, but a
prompt builder could still leak something if it is given more than a view.
Keep it a pure function of the view, and test it the way the engine's isolation
is tested:

```ts
renderPrompt(view: View): string   // no other arguments
```

- Equal views must produce equal prompts.
- Under the complementary deal the opponent's edge is `1 - myEdge`, so a model
  can derive it whether we mention it or not. Under the independent deal it
  cannot, which is the point of that variant.
- Never put the opponent's draw, the coin roll or the seed in a prompt.

## Order of work

1. `Policy`, `policyAgent`, and a schema-validated `elicitPolicy`. No engine
   change. Rate a model against the presets with the exact calculator.
2. `roundScript` extraction plus `playMatchAsync`, with the sync engine proven
   unchanged (the log digest check already used for every engine refactor).
3. Decision logging, `replayAgent`, and the replay-equals-log test.
4. Fallbacks, budget caps and the prompt cache.
