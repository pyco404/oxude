"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type AgentView, type LadderRow, type PlayResult, type Preset, type Preview } from "@/lib/api";

/** STUB_AUTH_MUST_NOT_SHIP: an owner id kept in this browser stands in for a wallet. */
const OWNER_KEY = "oxude.owner";
const AGENT_KEY = "oxude.agent";
const BRIEF_DEBOUNCE_MS = 1500;

const money = (n: number, digits = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}`;
const whole = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;

export default function Page() {
  const [ownerId, setOwnerId] = useState("");
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [tab, setTab] = useState<"preset" | "brief">("preset");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [chosen, setChosen] = useState<string>("");
  const [brief, setBrief] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<{ value: Preview; paid: boolean } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [autoPreview, setAutoPreview] = useState(true);
  const [paidCalls, setPaidCalls] = useState(0);
  const [firstFreeUsed, setFirstFreeUsed] = useState(false);
  const [ceiling, setCeiling] = useState(60);
  const [transcript, setTranscript] = useState<string>("");
  const [lastPlay, setLastPlay] = useState<PlayResult | null>(null);
  const [ladderTab, setLadderTab] = useState<"winnings" | "per-match">("winnings");
  const [ladder, setLadder] = useState<LadderRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const briefTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let id = localStorage.getItem(OWNER_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(OWNER_KEY, id);
    }
    setOwnerId(id);
    void api.presets().then((r) => {
      setPresets(r.presets);
      setChosen((c) => c || r.presets[0]?.name || "");
    });
  }, []);

  const refreshAgent = useCallback(
    async (id: string, owner: string) => {
      try {
        const { agent: fresh } = await api.agent(owner, id);
        setAgent({ ...fresh, id });
      } catch {
        localStorage.removeItem(AGENT_KEY);
        setAgent(null);
      }
    },
    [],
  );

  useEffect(() => {
    if (!ownerId) return;
    const saved = localStorage.getItem(AGENT_KEY);
    if (saved) void refreshAgent(saved, ownerId);
  }, [ownerId, refreshAgent]);

  const loadLadder = useCallback(async () => {
    const { rows } = await api.ladder(ladderTab);
    setLadder(rows);
  }, [ladderTab]);
  useEffect(() => {
    void loadLadder();
  }, [loadLadder]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError && e.retryAfter ? `${e.message} — try again in ${e.retryAfter}s` : String((e as Error).message));
    } finally {
      setBusy(null);
    }
  };

  // Free: rating a preset's table costs nothing, so it runs on every selection.
  useEffect(() => {
    if (tab !== "preset" || !ownerId || !chosen) return;
    const table = presets.find((p) => p.name === chosen)?.policyTable;
    if (!table) return;
    setPreviewing(true);
    void api
      .previewTable(ownerId, table)
      .then((r) => setPreview({ value: r.preview, paid: false }))
      .catch(() => setPreview(null))
      .finally(() => setPreviewing(false));
  }, [tab, chosen, presets, ownerId]);

  // Paid: rating a brief needs a model call, so it waits until typing stops.
  useEffect(() => {
    if (tab !== "brief" || !ownerId) return;
    if (briefTimer.current) clearTimeout(briefTimer.current);
    if (!autoPreview || brief.trim().length < 12) return;
    briefTimer.current = setTimeout(() => void ratePaidBrief(), BRIEF_DEBOUNCE_MS);
    return () => {
      if (briefTimer.current) clearTimeout(briefTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief, tab, autoPreview, ownerId]);

  const ratePaidBrief = async () => {
    if (!ownerId || brief.trim().length < 12) return;
    setPreviewing(true);
    setError(null);
    try {
      const r = await api.previewBrief(ownerId, brief.trim());
      setPreview({ value: r.preview, paid: true });
      if (r.elicitation?.free) setFirstFreeUsed(true);
      else setPaidCalls((n) => n + 1);
    } catch (e) {
      setPreview(null);
      setError(e instanceof ApiError && e.retryAfter ? `${e.message} — try again in ${e.retryAfter}s` : (e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const rent = () =>
    run("rent", async () => {
      const label = name.trim() || (tab === "preset" ? `${chosen} rental` : "My agent");
      const { agent: created, elicitation } = await api.rent(ownerId, {
        name: label,
        maxStake: ceiling,
        ...(tab === "preset" ? { presetName: chosen } : { brief: brief.trim() }),
      });
      if (elicitation?.free) setFirstFreeUsed(true);
      const id = created.id ?? created.agentId!;
      localStorage.setItem(AGENT_KEY, id);
      setAgent({ ...created, id });
      setTranscript("");
      setLastPlay(null);
      await loadLadder();
    });

  const play = () =>
    run("play", async () => {
      const id = agent?.id ?? agent?.agentId;
      if (!id) return;
      const result = await api.play(ownerId, id);
      setLastPlay(result);
      const { transcript: text } = await api.match(result.matchId);
      setTranscript(text);
      await Promise.all([refreshAgent(id, ownerId), loadLadder()]);
    });

  const release = () => {
    localStorage.removeItem(AGENT_KEY);
    setAgent(null);
    setTranscript("");
    setLastPlay(null);
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-24 pt-5 sm:px-6">
      <Header ownerId={ownerId} />

      {error ? (
        <p className="mb-4 border border-red/40 bg-red-dim/20 px-3 py-2 text-[13px] text-red" role="alert">
          {error}
        </p>
      ) : null}

      {agent ? (
        <AgentCard
          agent={agent}
          onPlay={play}
          onRelease={release}
          busy={busy === "play"}
          lastPlay={lastPlay}
          onCeiling={(value) =>
            run("ceiling", async () => {
              const id = agent.id ?? agent.agentId;
              if (!id) return;
              await api.setCeiling(ownerId, id, value);
              await refreshAgent(id, ownerId);
            })
          }
        />
      ) : (
        <RentPanel
          tab={tab}
          setTab={setTab}
          presets={presets}
          chosen={chosen}
          setChosen={setChosen}
          brief={brief}
          setBrief={setBrief}
          name={name}
          setName={setName}
          onRent={rent}
          busy={busy === "rent"}
          autoPreview={autoPreview}
          setAutoPreview={setAutoPreview}
          onRateBrief={ratePaidBrief}
          previewing={previewing}
          paidCalls={paidCalls}
          firstFree={!firstFreeUsed}
          ceiling={ceiling}
          setCeiling={setCeiling}
        />
      )}

      <PreviewPanel preview={preview} previewing={previewing} tab={agent ? null : tab} />
      <Transcript text={transcript} />
      <Ladder rows={ladder} tab={ladderTab} setTab={setLadderTab} mine={agent?.id ?? agent?.agentId} />
      <footer className="mt-10 border-t border-line pt-4 text-[11px] leading-5 text-muted">
        Ratings shown to you are exact against the roster as it stands today. The ladder ranks what agents actually won.
      </footer>
    </main>
  );
}

function Header({ ownerId }: { ownerId: string }) {
  return (
    <header className="mb-5">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-[0.2em] text-red">
          {/* The mark on its transparent field; the chrome around it stays flat. */}
          <img src="/oxude-tb.png" alt="" width={32} height={32} className="h-8 w-8" />
          OXUDE
        </h1>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {ownerId ? `owner ${ownerId.slice(0, 8)}` : "…"}
        </span>
      </div>
      <p className="mt-1 text-[13px] leading-5 text-muted">
        Rent an agent, write its brief, watch what it does. It plays itself.
      </p>
    </header>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex border border-line" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 px-3 py-2 text-[13px] transition-none ${
            value === o.value ? "bg-red text-ink font-medium" : "bg-panel text-muted hover:text-text"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function RentPanel(props: {
  tab: "preset" | "brief";
  setTab: (t: "preset" | "brief") => void;
  presets: Preset[];
  chosen: string;
  setChosen: (s: string) => void;
  brief: string;
  setBrief: (s: string) => void;
  name: string;
  setName: (s: string) => void;
  onRent: () => void;
  busy: boolean;
  autoPreview: boolean;
  setAutoPreview: (b: boolean) => void;
  onRateBrief: () => void;
  previewing: boolean;
  paidCalls: number;
  firstFree: boolean;
  ceiling: number;
  setCeiling: (n: number) => void;
}) {
  const ready = props.tab === "preset" ? Boolean(props.chosen) : props.brief.trim().length >= 12;
  return (
    <section className="border border-line bg-panel">
      <h2 className="border-b border-line px-3 py-2 text-[11px] uppercase tracking-wider text-muted">Rent an agent</h2>
      <div className="space-y-3 p-3">
        <Segmented
          value={props.tab}
          onChange={props.setTab}
          options={[
            { value: "preset", label: "Preset" },
            { value: "brief", label: "Brief" },
          ]}
        />

        {props.tab === "preset" ? (
          <ul className="grid grid-cols-2 gap-2">
            {props.presets.map((p) => (
              <li key={p.name}>
                <button
                  onClick={() => props.setChosen(p.name)}
                  aria-pressed={props.chosen === p.name}
                  className={`w-full border px-3 py-3 text-left ${
                    props.chosen === p.name ? "border-red bg-panel-2" : "border-line bg-panel hover:border-muted"
                  }`}
                >
                  <span className="block text-[15px] font-medium">{p.name}</span>
                  <span className="mt-0.5 block font-mono text-[10px] leading-4 text-muted">
                    {describe(p.policyTable)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-2">
            <textarea
              value={props.brief}
              onChange={(e) => props.setBrief(e.target.value)}
              rows={4}
              placeholder="Tell it how to play. Be specific: when to fold, when to raise, when to bluff."
              className="w-full resize-y border border-line bg-panel-2 px-3 py-2 font-mono text-[13px] leading-5 text-text placeholder:text-muted/60"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={props.autoPreview}
                  onChange={(e) => props.setAutoPreview(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[#ff2d2d]"
                />
                Rate as I type
              </label>
              <span className="font-mono">
                {props.brief.trim().length} chars · {props.firstFree ? "first call free" : `${props.paidCalls} model calls`}
              </span>
            </div>
            <button
              onClick={props.onRateBrief}
              disabled={props.brief.trim().length < 12 || props.previewing}
              className="w-full border border-red px-3 py-2 text-[13px] text-red disabled:border-line disabled:text-muted"
            >
              {props.previewing ? "Rating…" : "Rate this brief"}
              <span className="ml-2 font-mono text-[10px] uppercase tracking-wider">
                {props.firstFree ? "first one free" : "costs a model call"}
              </span>
            </button>
          </div>
        )}

        <input
          value={props.name}
          onChange={(e) => props.setName(e.target.value)}
          placeholder="Name your agent (optional)"
          className="w-full border border-line bg-panel-2 px-3 py-2 text-[13px] placeholder:text-muted/60"
        />

        <div className="border border-line px-3 py-2">
          <div className="flex items-baseline justify-between">
            <label htmlFor="ceiling" className="text-[11px] uppercase tracking-wider text-muted">
              Per-match ceiling
            </label>
            <span className="font-mono text-[13px] text-red">{props.ceiling}</span>
          </div>
          <input
            id="ceiling"
            type="range"
            min={10}
            max={60}
            step={5}
            value={props.ceiling}
            onChange={(e) => props.setCeiling(Number(e.target.value))}
            className="mt-2 w-full accent-[#ff2d2d]"
          />
          <p className="mt-1 text-[11px] leading-4 text-muted">
            The most this agent can lose in one match. It starts with 200 to play with.
          </p>
        </div>
        <button
          onClick={props.onRent}
          disabled={!ready || props.busy}
          className="w-full bg-red px-3 py-3 text-[14px] font-medium text-ink disabled:bg-line disabled:text-muted"
        >
          {props.busy ? "Renting…" : props.tab === "preset" ? `Rent ${props.chosen}` : "Rent on this brief"}
        </button>
        {props.tab === "brief" ? (
          <p className="text-[11px] leading-4 text-muted">
            Renting on a brief writes its table once, with one model call. Playing it after that is free.
          </p>
        ) : (
          <p className="text-[11px] leading-4 text-muted">Presets are free to rent and free to rate.</p>
        )}
      </div>
    </section>
  );
}

/** One line of plain English for a table, from its own actions. */
function describe(table: Record<string, Record<string, string>>): string {
  const lead = table["lead"] ?? {};
  const edges = Object.keys(lead).sort();
  const short = edges.map((e) => (lead[e] ?? "c")[0]).join(" ");
  return `first: ${short}`;
}

function AgentCard({
  agent,
  onPlay,
  onRelease,
  busy,
  lastPlay,
  onCeiling,
}: {
  agent: AgentView;
  onPlay: () => void;
  onRelease: () => void;
  busy: boolean;
  lastPlay: PlayResult | null;
  onCeiling: (value: number) => void;
}) {
  const retired = agent.retired === true;
  return (
    <section className="border border-line bg-panel">
      <h2 className="flex items-center justify-between border-b border-line px-3 py-2 text-[11px] uppercase tracking-wider text-muted">
        Your agent
        <button onClick={onRelease} className="text-[11px] normal-case tracking-normal text-muted hover:text-red">
          release
        </button>
      </h2>
      <div className="p-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-lg font-medium">{agent.name}</p>
          <span className="font-mono text-[11px] text-muted">{agent.presetName ?? "your brief"}</span>
        </div>

        <dl className="mt-3 grid grid-cols-3 gap-2 border border-line">
          <Stat label="balance" value={String(agent.balance ?? 0)} accent={(agent.balance ?? 0) <= 20} />
          <Stat label="net won" value={whole(agent.cumulativeNet ?? 0)} />
          <Stat label="matches" value={String(agent.matchesPlayed ?? 0)} />
        </dl>
        <dl className="mt-2 grid grid-cols-2 gap-2 border border-line">
          <Stat label="recent form" value={money(agent.recentForm ?? 0)} />
          <Stat label="ceiling" value={String(agent.maxStake ?? 0)} />
        </dl>

        {retired ? (
          <p className="mt-3 border border-red/50 px-3 py-2 text-[13px] leading-5 text-red">
            Out of money and retired. Its record is frozen at {whole(agent.cumulativeNet ?? 0)} over{" "}
            {agent.matchesPlayed ?? 0} matches, and it stays on the ladder.
          </p>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <label htmlFor="ceiling-live" className="text-[11px] uppercase tracking-wider text-muted">
              Ceiling
            </label>
            <input
              id="ceiling-live"
              type="range"
              min={10}
              max={60}
              step={5}
              defaultValue={agent.maxStake ?? 60}
              onMouseUp={(e) => onCeiling(Number((e.target as HTMLInputElement).value))}
              onTouchEnd={(e) => onCeiling(Number((e.target as HTMLInputElement).value))}
              className="flex-1 accent-[#ff2d2d]"
            />
            <span className="w-6 text-right font-mono text-[12px]">{agent.maxStake ?? 60}</span>
          </div>
        )}

        {typeof agent.trueRating === "number" ? (
          <p className="mt-2 font-mono text-[11px] leading-4 text-muted">
            private rating {money(agent.trueRating, 3)} per match, {agent.trueRatingBasis ?? "against today's roster"}
          </p>
        ) : null}

        <button
          onClick={onPlay}
          disabled={busy || retired}
          className="mt-3 w-full bg-red px-3 py-3 text-[14px] font-medium text-ink disabled:bg-line disabled:text-muted"
        >
          {retired ? "Retired" : busy ? "Playing…" : "Play a match"}
        </button>

        {lastPlay ? (
          <p className="mt-2 font-mono text-[11px] leading-4 text-muted">
            vs {lastPlay.opponent.name} · {lastPlay.result.rounds} rounds · staked {lastPlay.stake} ·{" "}
            <span className={lastPlay.result.net >= 0 ? "text-text" : "text-red"}>{whole(lastPlay.result.net)}</span>
            {lastPlay.result.net !== lastPlay.result.uncappedNet
              ? ` (capped from ${whole(lastPlay.result.uncappedNet)})`
              : ""}{" "}
            · paired by {lastPlay.matchmaking.path.replace("-", " ")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="border-r border-line px-3 py-2 last:border-r-0">
      <dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className={`mt-0.5 font-mono text-[15px] ${accent ? "text-red" : "text-text"}`}>{value}</dd>
    </div>
  );
}

function PreviewPanel({
  preview,
  previewing,
  tab,
}: {
  preview: { value: Preview; paid: boolean } | null;
  previewing: boolean;
  tab: "preset" | "brief" | null;
}) {
  if (tab === null) return null;
  const worst = preview ? Math.max(...preview.value.breakdown.map((b) => Math.abs(b.expectedNet)), 0.001) : 1;
  return (
    <section className="mt-3 border border-line bg-panel">
      <h2 className="flex items-center justify-between border-b border-line px-3 py-2 text-[11px] uppercase tracking-wider text-muted">
        Expected result
        <span className={`font-mono ${tab === "brief" ? "text-red" : "text-muted"}`}>
          {tab === "brief" ? "model call" : "free"}
        </span>
      </h2>
      <div className="p-3">
        {previewing ? (
          <p className="font-mono text-[13px] text-muted">rating…</p>
        ) : preview ? (
          <>
            <p className="font-mono text-3xl text-red">{money(preview.value.trueRating, 3)}</p>
            <p className="mt-1 text-[12px] leading-4 text-muted">
              per match, {preview.value.basis} ({preview.value.roster} agents)
            </p>
            <ul className="mt-3 space-y-1.5">
              {preview.value.breakdown.map((b, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 font-mono text-[11px] text-muted">
                    {b.weight} agent{b.weight === 1 ? "" : "s"}
                  </span>
                  <span className="h-2 flex-1 bg-panel-2">
                    <span
                      className={`block h-2 ${b.expectedNet >= 0 ? "bg-red" : "bg-line"}`}
                      style={{ width: `${Math.min(100, (Math.abs(b.expectedNet) / worst) * 100)}%` }}
                    />
                  </span>
                  <span className="w-14 shrink-0 text-right font-mono text-[11px]">{money(b.expectedNet)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-[13px] leading-5 text-muted">
            {tab === "preset" ? "Pick a preset to see what it is worth." : "Write a brief, then rate it."}
          </p>
        )}
      </div>
    </section>
  );
}

/** The centrepiece: the thing people screenshot. */
function Transcript({ text }: { text: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  if (!text) return null;
  return (
    <section className="mt-3 border border-line bg-panel">
      <h2 className="flex items-center justify-between border-b border-line px-3 py-2 text-[11px] uppercase tracking-wider text-muted">
        Transcript
        <button
          onClick={() => void navigator.clipboard?.writeText(text)}
          className="text-[11px] normal-case tracking-normal text-muted hover:text-red"
        >
          copy
        </button>
      </h2>
      <div className="overflow-x-auto px-3 py-4 sm:px-5 sm:py-6">
        <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 sm:text-[14px] sm:leading-7">
          {lines.map((line, i) => (
            <span key={i} className={lineClass(line)}>
              {line || " "}
              {"\n"}
            </span>
          ))}
        </pre>
      </div>
    </section>
  );
}

const BEATS = [
  "A bluff that worked",
  "The bluff was called",
  "folded the better hand",
  "takes the match",
  "biggest pot",
];

function lineClass(line: string): string {
  if (BEATS.some((b) => line.includes(b))) return "text-red";
  if (line.startsWith("  Running:")) return "text-muted";
  if (/^Round \d+\./.test(line)) return "text-text font-medium";
  if (line.startsWith("Final:") || / wins the match|ends level/.test(line)) return "text-text font-medium";
  return "text-text/80";
}

function Ladder({
  rows,
  tab,
  setTab,
  mine,
}: {
  rows: LadderRow[];
  tab: "winnings" | "per-match";
  setTab: (t: "winnings" | "per-match") => void;
  mine?: string;
}) {
  return (
    <section className="mt-3 border border-line bg-panel">
      <h2 className="border-b border-line px-3 py-2 text-[11px] uppercase tracking-wider text-muted">Ladder</h2>
      <div className="p-3">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "winnings", label: "Winnings" },
            { value: "per-match", label: "Per match" },
          ]}
        />
        <ol className="mt-3">
          {rows.map((row, i) => (
            <li
              key={row.agentId}
              className={`flex items-center gap-2 border-b border-line py-2 text-[13px] last:border-b-0 ${
                row.agentId === mine ? "text-red" : ""
              }`}
            >
              <span className="w-6 shrink-0 font-mono text-[11px] text-muted">{i + 1}</span>
              <span className={`min-w-0 flex-1 truncate ${row.retired ? "text-muted line-through" : ""}`}>{row.name}</span>
              {row.retired ? (
                <span className="shrink-0 border border-line px-1 font-mono text-[9px] uppercase tracking-wider text-muted">
                  retired
                </span>
              ) : null}
              <span className="w-12 shrink-0 text-right font-mono text-[11px] text-muted">{row.matchesPlayed}m</span>
              <span className="w-20 shrink-0 text-right font-mono">
                {tab === "winnings" ? whole(row.cumulativeNet) : money(row.netPerMatch ?? 0)}
              </span>
            </li>
          ))}
          {rows.length === 0 ? <li className="py-2 text-[13px] text-muted">No agents yet.</li> : null}
        </ol>
        <p className="mt-2 text-[11px] leading-4 text-muted">
          {tab === "winnings" ? "All-time net won. Volume counts." : "Net per match. Needs at least one match."}
        </p>
      </div>
    </section>
  );
}
