"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type AutoplayStatus, type SinceYouLeft } from "@/lib/api";
import { useWallet } from "./wallet-context";
import { netTone } from "@/lib/tone";

/** How often the panel asks the server what is true now. The countdown ticks locally in between. */
const REFRESH_MS = 30_000;

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** "4 min", "1 h 12 min": a duration, rounded to what a person reads. */
function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const ago = (iso: string, now: number) => `${duration(now - new Date(iso).getTime())} ago`;

/** The interval itself, which can be seconds on devnet: "10 min", "20 s". */
function every(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : duration(ms);
}

/** "in ~6 min", or "within a minute" rather than "in ~under a minute". */
function until(target: number, now: number): string {
  const ms = target - now;
  if (ms <= 0) return "any moment";
  if (ms < 60_000) return "within a minute";
  return `in ~${duration(ms)}`;
}

/**
 * Autoplay: the server plays this agent on a timer while its owner is away.
 *
 * The one distinction this panel must never blur is hold versus pause. A hold
 * clears itself and asks nothing of the owner; a pause has stopped for good
 * until they switch it back on. They get different words and different colours.
 */
export function AutoplayPanel({
  agentId,
  retired,
  refreshKey,
  onChanged,
}: {
  agentId: string;
  retired: boolean;
  /** Anything that changes when the agent might have played. */
  refreshKey: string;
  /** After autoplay played or stopped: the card's balance may be stale. */
  onChanged: () => void;
}) {
  const { session } = useWallet();
  const token = session?.token ?? null;
  const [status, setStatus] = useState<AutoplayStatus | null>(null);
  const [summary, setSummary] = useState<SinceYouLeft | null>(null);
  const [floor, setFloor] = useState("");
  const [floorDirty, setFloorDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Refs, so that `load` stays the same function across renders: otherwise a
  // new onChanged from the parent, or every keystroke in the floor box, would
  // restart the refresh timer and fire an extra request.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const floorDirtyRef = useRef(false);
  floorDirtyRef.current = floorDirty;
  const lastMatchRef = useRef<string | null | undefined>(undefined);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.agent(token, agentId);
      if (!res.autoplay) return;
      // The card's balance is stale once autoplay has played since we last looked.
      const last = res.autoplay.lastMatchAt;
      if (lastMatchRef.current !== undefined && lastMatchRef.current !== last) onChangedRef.current();
      lastMatchRef.current = last;
      setStatus(res.autoplay);
      if (!floorDirtyRef.current) setFloor(res.autoplay.floor === null ? "" : String(res.autoplay.floor));
      if (res.sinceYouLeft === null) {
        // Never seen before: start the clock now, so the next visit has something to report.
        void api.markSeen(token, agentId).catch(() => undefined);
      } else if (res.sinceYouLeft) {
        setSummary(res.sinceYouLeft);
      }
    } catch {
      // Leave what we have on screen; the next refresh will try again.
    }
  }, [token, agentId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load, refreshKey]);

  // The countdown moves between refreshes.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const parsedFloor = floor.trim() === "" ? null : Number(floor);
  const floorValid = parsedFloor === null || (Number.isInteger(parsedFloor) && parsedFloor >= 0);

  const save = async (enabled: boolean) => {
    if (!token || !floorValid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.setAutoplay(token, agentId, { enabled, floor: parsedFloor });
      setStatus(res.autoplay);
      setFloorDirty(false);
      onChangedRef.current();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't reach the server. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setSummary(null);
    if (token) await api.markSeen(token, agentId).catch(() => undefined);
  };

  if (!token || !status) return null;

  const { state } = status;
  const on = status.enabled;
  const tone =
    state === "paused"
      ? "border-loss/60 text-loss"
      : state === "held"
        ? "border-line text-text"
        : "border-line text-muted";

  return (
    <section className="rounded-panel mt-3 border border-line">
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <h3 className="text-[12px] uppercase tracking-wider text-accent">Autoplay</h3>
        <span
          className={`font-mono text-[12px] uppercase tracking-wider ${
            state === "on" || state === "waiting" ? "text-text" : state === "paused" ? "text-loss" : "text-muted"
          }`}
        >
          {state === "waiting" ? "on · waiting" : state}
        </span>
      </div>

      {summary && summary.matches > 0 ? (
        <div className="border-b border-line bg-panel-2 px-3 py-2 text-[13px] leading-5">
          <div className="flex items-start justify-between gap-3">
            <p>
              <span className="text-muted">Since you left ({ago(summary.since, now)}):</span>{" "}
              <span className="font-mono">{summary.matches}</span>{" "}
              {summary.matches === 1 ? "match" : "matches"},{" "}
              <span className={netTone(summary.net)}>{signed(summary.net)}</span>.
            </p>
            <button onClick={() => void dismiss()} className="shrink-0 text-[11px] text-muted hover:text-text">
              Dismiss
            </button>
          </div>
          {summary.bestHand ? (
            <p className="mt-1 text-[12px] text-muted">
              Best hand:{" "}
              <Link href={`/m/${summary.bestHand.matchId}`} className={`${netTone(summary.bestHand.net)} underline-offset-2 hover:underline`}>
                {signed(summary.bestHand.net)}
              </Link>
              {summary.bestHand.headline ? ` — ${summary.bestHand.headline}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-[12px] text-muted">No winning match in that stretch.</p>
          )}
        </div>
      ) : null}

      <div className="p-4">
        {status.message ? (
          <div className={`rounded-panel mb-3 border px-3 py-2 text-[13px] leading-5 ${tone}`}>
            <p className="font-medium">{status.message}</p>
            {status.action ? <p className="mt-0.5 text-[12px] text-muted">{status.action}</p> : null}
          </div>
        ) : null}

        {state === "waiting" && status.waitingSince ? (
          <p className="rounded-panel mb-3 border border-line px-3 py-2 text-[13px] leading-5 text-muted">
            Waiting for an opponent for {duration(now - new Date(status.waitingSince).getTime())}. Nobody in this band
            can play right now; it keeps trying and plays the moment someone can.
          </p>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[12px]">
          <dt className="text-muted">Last match</dt>
          <dd className="text-right">{status.lastMatchAt ? ago(status.lastMatchAt, now) : "not yet"}</dd>
          <dt className="text-muted">Next match</dt>
          <dd className="text-right">
            {status.nextMatchAt ? until(new Date(status.nextMatchAt).getTime(), now) : "—"}
          </dd>
          <dt className="text-muted">Today (UTC)</dt>
          <dd className="text-right">
            {status.today.matches} {status.today.matches === 1 ? "match" : "matches"},{" "}
            <span className={netTone(status.today.net)}>{signed(status.today.net)}</span>
          </dd>
        </dl>

        {!retired ? (
          <>
            <label className="mt-3 block text-[12px] uppercase tracking-wider text-muted" htmlFor={`floor-${agentId}`}>
              Balance floor
            </label>
            <input
              id={`floor-${agentId}`}
              inputMode="numeric"
              value={floor}
              onChange={(e) => {
                setFloor(e.target.value);
                setFloorDirty(true);
              }}
              placeholder="none"
              className={`rounded-panel mt-1 w-full border bg-ink px-2 py-1.5 font-mono text-[13px] text-gold ${
                floorValid ? "border-line" : "border-loss"
              }`}
            />
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Pauses before any match that could take you below this. Leave it empty to play until the balance can no
              longer cover the band.
            </p>
            {!floorValid ? <p className="mt-1 text-[11px] text-loss">A whole number of chips, or empty.</p> : null}

            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => void save(!on)}
                disabled={busy || !floorValid}
                className={`px-3 py-2 text-[13px] font-medium disabled:bg-line disabled:text-muted ${
                  on ? "border border-line text-text" : "bg-accent text-ink"
                }`}
              >
                {busy ? "Saving…" : on ? "Turn off" : state === "paused" ? "Switch back on" : "Turn on"}
              </button>
              <button
                onClick={() => void save(on)}
                disabled={busy || !floorValid || !floorDirty}
                className="rounded-panel border border-line px-3 py-2 text-[13px] disabled:opacity-40"
              >
                Save floor
              </button>
            </div>
          </>
        ) : null}

        {error ? <p className="mt-2 text-[12px] text-loss">{error}</p> : null}

        <p className="mt-3 text-[12px] leading-5 text-muted">
          One match every {every(status.intervalMs)}, played on the server: you don&apos;t need this page open and
          you sign nothing. It may meet house agents when no other player is free &mdash; those matches settle for
          money but don&apos;t count toward the ladder.
        </p>
      </div>
    </section>
  );
}
