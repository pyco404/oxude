"use client";

import { AgentMark } from "@/app/agent-name";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Transcript } from "@/app/transcript";
import { BluffCard, LiveFeed, useFeed } from "@/app/feed";
import { LadderPanel } from "@/app/ladder-panel";
import { Segmented } from "@/app/ui";
import { PrivyOption } from "@/app/privy-option";
import { useWallet } from "@/app/wallet-context";
import { WithdrawPanel } from "@/app/withdraw-panel";
import { PageNote } from "@/app/site-header";
import { useCountUp } from "@/lib/motion";
import {
  installUrl,
  type WalletName,
} from "@/lib/wallet";
import { api, ApiError, BANDS, bandOf, type Feed, type RosterAgent, type AgentView, type PlayResult, type Preset, type Preview } from "@/lib/api";

const AGENT_KEY = "oxude.agent";
const BRIEF_DEBOUNCE_MS = 1500;

const money = (n: number, digits = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}`;
const whole = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;

export default function Home({ initialFeed }: { initialFeed: Feed | null }) {
  const feed = useFeed(initialFeed);
  // Sign-in is site-wide: the mobile top bar and this page share one session.
  const wallet = useWallet();
  const { session, wallets } = wallet;
  const token = session?.token ?? null;
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
  const [presetRatings, setPresetRatings] = useState<Record<string, number>>({});
  // undefined while loading, null if the request failed: neither may read as "nobody here".
  const [roster, setRoster] = useState<RosterAgent[] | null | undefined>(undefined);
  // Set once the player moves the slider, so the busiest-band default never overrides a choice.
  const ceilingTouched = useRef(false);
  const [transcript, setTranscript] = useState<string>("");
  const [lastPlay, setLastPlay] = useState<PlayResult | null>(null);
  // Bumped after renting or playing, so the ladder refetches.
  const [ladderKey, setLadderKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const briefTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void api.presets().then((r) => {
      setPresets(r.presets);
      setChosen((c) => c || r.presets[0]?.name || "");
    });
  }, []);

  // Signing out, from here or the top bar, puts the agent card away.
  useEffect(() => {
    if (!session) setAgent(null);
  }, [session]);

  const connect = (name: WalletName) => void wallet.connect(name);

  const refreshAgent = useCallback(
    async (id: string, sessionToken: string | null) => {
      try {
        const { agent: fresh } = await api.agent(sessionToken, id);
        setAgent({ ...fresh, id });
      } catch {
        localStorage.removeItem(AGENT_KEY);
        setAgent(null);
      }
    },
    [],
  );

  // Your agent is only yours while you are signed in as its owner.
  useEffect(() => {
    if (!token) return;
    const saved = localStorage.getItem(AGENT_KEY);
    if (saved) void refreshAgent(saved, token);
  }, [token, refreshAgent]);


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

  // Free: every preset rated once against today's roster, so the picker can compare them.
  useEffect(() => {
    if (presets.length === 0) return;
    void Promise.all(
      presets.map(async (p) => [p.name, (await api.previewTable(null, p.policyTable)).preview.trueRating] as const),
    )
      .then((pairs) => setPresetRatings(Object.fromEntries(pairs)))
      .catch(() => setPresetRatings({}));
  }, [presets]);

  // Who you would meet: your agent's band once you have one, otherwise the band
  // the ceiling you are about to rent at would put you in.
  const band = bandOf(agent?.maxStake ?? ceiling);
  useEffect(() => {
    void api
      .roster(band)
      .then((r) => setRoster(r.agents))
      .catch(() => setRoster(null));
  }, [band, agent?.matchesPlayed]);

  // Start the ceiling in the band with the most agents, so a newcomer has someone to meet.
  useEffect(() => {
    void api
      .roster()
      .then(({ counts }) => {
        if (ceilingTouched.current || !counts) return;
        const busiest = BANDS.reduce((best, b) => ((counts[b.name] ?? 0) > (counts[best.name] ?? 0) ? b : best));
        setCeiling(busiest.max);
      })
      .catch(() => {});
  }, []);

  // Free: rating a preset's table costs nothing, so it runs on every selection.
  useEffect(() => {
    if (tab !== "preset" || !chosen) return;
    const table = presets.find((p) => p.name === chosen)?.policyTable;
    if (!table) return;
    setPreviewing(true);
    void api
      .previewTable(null, table)
      .then((r) => setPreview({ value: r.preview, paid: false }))
      .catch(() => setPreview(null))
      .finally(() => setPreviewing(false));
  }, [tab, chosen, presets]);

  // Paid: rating a brief needs a model call, so it waits until typing stops.
  useEffect(() => {
    if (tab !== "brief" || !token) return;
    if (briefTimer.current) clearTimeout(briefTimer.current);
    if (!autoPreview || brief.trim().length < 12) return;
    briefTimer.current = setTimeout(() => void ratePaidBrief(), BRIEF_DEBOUNCE_MS);
    return () => {
      if (briefTimer.current) clearTimeout(briefTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief, tab, autoPreview, token]);

  const ratePaidBrief = async () => {
    if (!token || brief.trim().length < 12) return;
    setPreviewing(true);
    setError(null);
    try {
      const r = await api.previewBrief(token, brief.trim());
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
      const { agent: created, elicitation } = await api.rent(token, {
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
      setLadderKey((k) => k + 1);
    });

  const play = () =>
    run("play", async () => {
      const id = agent?.id ?? agent?.agentId;
      if (!id) return;
      const result = await api.play(token, id);
      setLastPlay(result);
      const { transcript: text } = await api.match(result.matchId);
      setTranscript(text);
      await refreshAgent(id, token);
      setLadderKey((k) => k + 1);
    });

  const release = () => {
    localStorage.removeItem(AGENT_KEY);
    setAgent(null);
    setTranscript("");
    setLastPlay(null);
  };

  const agentOrRent = agent ? (
    <AgentCard
      agent={agent}
      onPlay={play}
      onRelease={release}
      busy={busy === "play"}
      lastPlay={lastPlay}
      onWithdrawn={() => {
        const id = agent.id ?? agent.agentId;
        if (id) void refreshAgent(id, token);
        setLadderKey((k) => k + 1);
      }}
      onCeiling={(value) =>
        run("ceiling", async () => {
          const id = agent.id ?? agent.agentId;
          if (!id) return;
          await api.setCeiling(token, id, value);
          await refreshAgent(id, token);
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
      setCeiling={(n) => {
        ceilingTouched.current = true;
        setCeiling(n);
      }}
      presetRatings={presetRatings}
      signedIn={Boolean(session)}
    />
  );

  return (
    <main className="w-full px-4 pb-10 pt-5 lg:px-10 lg:pt-8">
      <Header />

      {error ?? wallet.error ? (
        <p className="mb-4 border border-red/40 bg-red-dim/20 px-3 py-2 text-[13px] text-red" role="alert">
          {error ?? wallet.error}
        </p>
      ) : null}

      {/* Two columns from lg: the game on the left, renting on the right. Below lg they stack in this order. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:items-start xl:grid-cols-[minmax(0,1fr)_minmax(0,480px)]">
        <div className="flex min-w-0 flex-col gap-3 *:m-0">
          {/* Signed out, the game comes first: a bluff and the live feed, then the ask. */}
          {session ? null : (
            <>
              <BluffCard bluff={feed?.bluff ?? null} />
              <LiveFeed feed={feed} />
            </>
          )}
          {session ? agentOrRent : null}
          {session ? <PreviewPanel preview={preview} previewing={previewing} tab={agent ? null : tab} /> : null}
          {session ? <Transcript text={transcript} {...(lastPlay ? { matchId: lastPlay.matchId } : {})} /> : null}
        </div>

        <div className="flex min-w-0 flex-col gap-3 *:m-0">
          {session ? null : <ConnectPanel
              wallets={wallets}
              onConnect={connect}
              busy={wallet.busy === "connect"}
            />}
          {session ? null : agentOrRent}
          {session ? null : <PreviewPanel preview={preview} previewing={previewing} tab={agent ? null : tab} />}
          <RosterPanel
            band={band}
            agents={roster ? roster.filter((a) => a.agentId !== (agent?.id ?? agent?.agentId)) : roster}
            fromAgent={Boolean(agent)}
          />
          {session ? <LiveFeed feed={feed} /> : null}
          <LadderPanel refreshKey={ladderKey} mine={agent?.id ?? agent?.agentId} />
        </div>
      </div>
      <PageNote>
        Ratings shown to you are exact against the roster as it stands today. The ladder ranks what agents actually won.
      </PageNote>
    </main>
  );
}

function Header() {
  return (
    <p className="mb-4 max-w-2xl text-[13px] leading-5 text-muted lg:text-[15px] lg:leading-6">
      AI agents play bluff-and-fold against each other, staked and settled on Solana. Every hand is shown.
    </p>
  );
}

/**
 * Sign-in. The wallet signs a plain-text message, never a transaction, and the
 * panel says so, because a signing prompt is exactly where people get phished.
 */
function ConnectPanel({
  wallets,
  onConnect,
  busy,
}: {
  wallets: WalletName[];
  onConnect: (name: WalletName) => void;
  busy: boolean;
}) {
  const all: WalletName[] = ["Phantom", "Solflare"];
  return (
    <div className="mb-3 border border-line bg-panel p-3">
      <p className="text-[13px] leading-5">Want one of your own? Sign in to rent an agent and play.</p>
      <p className="mt-1 text-[11px] leading-4 text-muted">
        You sign a message, not a transaction: it costs nothing and moves nothing. Browsing needs no wallet.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {all.map((name) =>
          wallets.includes(name) ? (
            <button
              key={name}
              onClick={() => onConnect(name)}
              disabled={busy}
              className="bg-red px-3 py-2 text-[13px] font-medium text-ink disabled:bg-line disabled:text-muted"
            >
              {busy ? "Waiting…" : name}
            </button>
          ) : (
            <a
              key={name}
              href={installUrl(name)}
              target="_blank"
              rel="noreferrer"
              className="border border-line px-3 py-2 text-center text-[13px] text-muted"
            >
              Get {name}
            </a>
          ),
        )}
      </div>
      <PrivyOption label="No wallet? Sign in with email or X" />
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
  presetRatings: Record<string, number>;
  signedIn: boolean;
}) {
  const ready =
    props.signedIn && (props.tab === "preset" ? Boolean(props.chosen) : props.brief.trim().length >= 12);
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
          <>
          <ul className="space-y-2">
            {props.presets.map((p, index) => (
              <PresetCard
                key={p.name}
                preset={p}
                index={index}
                rating={props.presetRatings[p.name]}
                selected={props.chosen === p.name}
                onSelect={() => props.setChosen(p.name)}
              />
            ))}
          </ul>
          <p className="text-[11px] leading-4 text-muted">
            Figures are exact expected net per match against the roster as it stands today. Free to see.
          </p>
          </>
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
              disabled={!props.signedIn || props.brief.trim().length < 12 || props.previewing}
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
            Decides who it meets: agents are matched inside a band (10-20, 20-40, 40-60). It starts with 180 to play with.
          </p>
        </div>
        <button
          onClick={props.onRent}
          disabled={!ready || props.busy}
          className="w-full bg-red px-3 py-3 text-[14px] font-medium text-ink disabled:bg-line disabled:text-muted"
        >
          {!props.signedIn
            ? "Sign in to rent"
            : props.busy
              ? "Renting…"
              : props.tab === "preset"
                ? `Rent ${props.chosen}`
                : "Rent on this brief"}
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

/** Arrival timing for the preset cards. */
const BAR_STAGGER_MS = 30;
const CARD_STAGGER_MS = 80;

function PresetCard({
  preset,
  index,
  rating,
  selected,
  onSelect,
}: {
  preset: Preset;
  index: number;
  rating: number | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  // Counts in on the same beat as this card's bars.
  const shown = useCountUp(rating, 400, index * CARD_STAGGER_MS);
  return (
    <li>
      <button
        onClick={onSelect}
        aria-pressed={selected}
        className={`card-border w-full border px-3 py-3 text-left ${
          selected ? "border-red bg-panel-2" : "border-line bg-panel hover:border-muted"
        }`}
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="text-[15px] font-medium">
            <AgentMark preset={preset.name} />
            {preset.name}
          </span>
          {/* The final figure is what screen readers get, not the frames in between. */}
          <span className="font-mono text-[12px] text-muted" aria-label={rating === undefined ? undefined : `${money(rating, 3)} per match`}>
            {shown === undefined ? "…" : `${money(shown, 3)} / match`}
          </span>
        </span>
        <span className="mt-1 block text-[12px] leading-5 text-muted">{preset.description}</span>
        <Behaviour table={preset.policyTable} delayMs={index * CARD_STAGGER_MS} />
      </button>
    </li>
  );
}

/**
 * What a table does when it acts first, edge by edge: a filled square raises,
 * an outlined one calls, a faint one folds. Readable at a glance, no codes.
 * Each square wipes in once on arrival and then holds still.
 */
function Behaviour({ table, delayMs = 0 }: { table: Record<string, Record<string, string>>; delayMs?: number }) {
  const lead = table["lead"] ?? {};
  const edges = Object.keys(lead).sort();
  return (
    <span className="mt-2 flex items-end gap-1.5" aria-label="what it does when acting first">
      {edges.map((edge, i) => {
        const action = lead[edge];
        return (
          <span key={edge} className="flex flex-col items-center gap-0.5">
            <span
              title={`${action} at ${edge}`}
              style={{ animationDelay: `${delayMs + i * BAR_STAGGER_MS}ms` }}
              className={`bar-wipe block h-3 w-6 ${
                action === "raise" ? "bg-red" : action === "call" ? "border border-muted" : "bg-line"
              }`}
            />
            <span className="font-mono text-[9px] text-muted">{edge.slice(1)}</span>
          </span>
        );
      })}
      <span className="ml-2 font-mono text-[9px] leading-3 text-muted">
        <span className="text-red">raise</span> · call · <span className="opacity-60">fold</span>
      </span>
    </span>
  );
}

/** Who you would meet: the agents in your band. */
function RosterPanel({
  band,
  agents,
  fromAgent,
}: {
  band: string;
  agents: RosterAgent[] | null | undefined;
  fromAgent: boolean;
}) {
  return (
    <section className="mt-3 border border-line bg-panel">
      <h2 className="flex items-center justify-between border-b border-line px-3 py-2 text-[11px] uppercase tracking-wider text-muted">
        Who you'd meet
        <span className="font-mono normal-case tracking-normal">band {band}</span>
      </h2>
      <div className="p-3">
        <p className="mb-2 text-[12px] leading-5 text-muted">
          {fromAgent
            ? "Your ceiling puts you in this band. You are only matched inside it."
            : "The ceiling you rent at decides the band. You are only matched inside it."}
        </p>
        {agents === undefined ? (
          <p className="text-[13px] text-muted">Loading…</p>
        ) : agents === null ? (
          <p className="text-[13px] text-muted">Couldn&apos;t reach the server. Try again in a moment.</p>
        ) : agents.length === 0 ? (
          <p className="text-[13px] text-muted">Nobody in this band right now.</p>
        ) : (
          <ul>
            {agents.slice(0, 8).map((a) => (
              <li key={a.agentId} className="flex items-center gap-2 border-b border-line py-2 text-[13px] last:border-b-0">
                <span className="min-w-0 flex-1 truncate">
                  <AgentMark preset={a.presetName} />
                  {a.name}
                </span>
                <span className="w-14 shrink-0 font-mono text-[10px] text-muted">{a.presetName ?? "brief"}</span>
                <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted">{a.matchesPlayed}m</span>
                <span className="w-12 shrink-0 text-right font-mono text-[11px]">{a.balance}</span>
              </li>
            ))}
          </ul>
        )}
        {agents && agents.length > 8 ? (
          <p className="mt-2 text-[11px] text-muted">and {agents.length - 8} more in this band</p>
        ) : null}
        <p className="mt-2 font-mono text-[10px] text-muted">name · plays as · matches · balance</p>
      </div>
    </section>
  );
}

function AgentCard({
  agent,
  onPlay,
  onRelease,
  busy,
  lastPlay,
  onCeiling,
  onWithdrawn,
}: {
  agent: AgentView;
  onPlay: () => void;
  onRelease: () => void;
  busy: boolean;
  lastPlay: PlayResult | null;
  onCeiling: (value: number) => void;
  /** After a withdrawal: the balance and maybe retirement changed. */
  onWithdrawn: () => void;
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
          <p className="text-lg font-medium">
            <AgentMark preset={agent.presetName} />
            {agent.name}
          </p>
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
            Retired with {agent.balance ?? 0} left: it can&apos;t play again. Its record is frozen at{" "}
            {whole(agent.cumulativeNet ?? 0)} over {agent.matchesPlayed ?? 0} matches, and it stays on the ladder.
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

        {/* Stays mounted when the agent retires, so the withdrawal that retired it can say so. */}
        {!(agent.id ?? agent.agentId) ? null : (
          <WithdrawPanel
            agentId={(agent.id ?? agent.agentId)!}
            agentName={agent.name}
            refreshKey={`${agent.balance ?? ""}-${agent.matchesPlayed ?? ""}`}
            onChanged={onWithdrawn}
          />
        )}
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

