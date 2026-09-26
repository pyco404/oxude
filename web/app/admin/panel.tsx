"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type AdminHealth, type OpTrouble } from "@/lib/api";
import { useWallet } from "@/app/wallet-context";

/**
 * Operational health, for the operator.
 *
 * The order on this page is the order things go wrong in, not the order they
 * are interesting in: settlement first, then the money, then the keys that pay
 * for it, then the ops to go and look at. Volume is at the bottom because it
 * is what you read when nothing is wrong.
 *
 * Every figure comes from the API, which reads them from where they already
 * live. Nothing here computes anything, on purpose: a dashboard that does its
 * own arithmetic is a second implementation that can disagree with the first.
 */

const BASE = 1e6;
const chips = (baseUnits: number) => (baseUnits / BASE).toLocaleString("en-US", { maximumFractionDigits: 2 });
const num = (n: number) => n.toLocaleString("en-US");

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function Row({ label, value, tone = "plain", sub }: { label: string; value: string; tone?: "plain" | "good" | "bad"; sub?: string }) {
  const colour = tone === "bad" ? "text-red" : tone === "good" ? "text-gold" : "text-text";
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-2 last:border-b-0">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="text-right">
        <span className={`font-mono text-[13px] ${colour}`}>{value}</span>
        {sub ? <span className="ml-2 text-[11px] text-muted">{sub}</span> : null}
      </span>
    </div>
  );
}

function Card({ title, state, children }: { title: string; state?: "ok" | "warn" | "unknown"; children: React.ReactNode }) {
  const dot = state === "warn" ? "bg-red" : state === "ok" ? "bg-gold" : "bg-line";
  return (
    <section className="rounded-panel border border-line bg-panel">
      <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-[12px] uppercase tracking-wider text-muted">
        {state ? <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden /> : null}
        {title}
      </h2>
      <div className="px-4 py-2">{children}</div>
    </section>
  );
}

function Ops({ title, ops, empty }: { title: string; ops: OpTrouble[]; empty: string }) {
  if (ops.length === 0) return <Row label={title} value="none" tone="good" sub={empty} />;
  return (
    <div className="py-2">
      <p className="mb-1 text-[12px] text-red">
        {title}: {ops.length}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-[12px]">
          <thead className="text-[11px] uppercase tracking-wider text-muted">
            <tr className="border-b border-line">
              <th className="py-1 pr-3 font-normal">Seq</th>
              <th className="py-1 pr-3 font-normal">Kind</th>
              <th className="py-1 pr-3 font-normal">Agent</th>
              <th className="py-1 pr-3 text-right font-normal">Chips</th>
              <th className="py-1 pr-3 text-right font-normal">Tries</th>
              <th className="py-1 pr-3 text-right font-normal">Age</th>
              <th className="py-1 font-normal">Last error</th>
            </tr>
          </thead>
          <tbody>
            {ops.slice(0, 25).map((o) => (
              <tr key={o.id} className="border-b border-line last:border-b-0 align-top">
                <td className="py-1 pr-3 font-mono text-muted">{o.seq}</td>
                <td className="py-1 pr-3">{o.kind}</td>
                <td className="py-1 pr-3">{o.agentName ?? o.agentId?.slice(0, 8) ?? "—"}</td>
                <td className="py-1 pr-3 text-right font-mono">{chips(o.amount)}</td>
                <td className="py-1 pr-3 text-right font-mono">{o.attempts}</td>
                <td className="py-1 pr-3 text-right font-mono text-muted">{duration(o.ageMs)}</td>
                <td className="py-1 text-muted">{o.lastError ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AdminPanel() {
  const { session } = useWallet();
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      setHealth(await api.admin(session.token));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? { status: e.status, message: e.message } : { status: 0, message: String(e) });
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
    // Read again on a timer: this page is opened when something looks wrong,
    // which is exactly when a figure that stopped updating is worst.
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (!session) {
    return <p className="text-[13px] text-muted">Sign in with the operator wallet to see this.</p>;
  }
  if (error?.status === 404) {
    // The API says 404 for a wallet that is not on the list, and this says the
    // same thing: no hint that there is a page here for somebody else.
    return <p className="text-[13px] text-muted">Not found.</p>;
  }
  if (error) {
    return (
      <p className="text-[13px] text-red">
        {error.message} <button onClick={() => void load()} className="ml-2 underline">retry</button>
      </p>
    );
  }
  if (!health) return <p className="text-[13px] text-muted">Reading…</p>;

  const { settlement, settlers, books, ops, volume } = health;
  const lagBad = settlement.stalled;
  const short = books !== null && books.solvency.difference < 0;
  const mism = books?.reconcile.mismatches ?? [];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[11px] text-muted">
        Read {new Date(health.at).toISOString().replace("T", " ").slice(0, 19)}Z, again every 30s
        {loading ? " · reading…" : ""}
      </p>

      <Card title="Solvency" state={books === null ? "unknown" : short ? "warn" : "ok"}>
        {books === null ? (
          <Row label="Vaults" value="not reachable" sub="no settlement program is configured on this server" />
        ) : (
          <>
            <Row
              label="Ledger says players own"
              value={`${chips(books.solvency.ledger)} chips`}
            />
            <Row label="Vaults actually hold" value={`${chips(books.solvency.chain)} chips`} />
            <Row
              label="Difference"
              value={`${books.solvency.difference >= 0 ? "+" : "−"}${chips(Math.abs(books.solvency.difference))}`}
              tone={books.solvency.difference === 0 ? "good" : "bad"}
              sub={books.solvency.difference === 0 ? "the books add up" : "vaults hold less than the ledger says"}
            />
            <Row
              label="Counted"
              value={`${books.solvency.counted} vaults`}
              sub={books.solvency.unreachable > 0 ? `${books.solvency.unreachable} unreachable` : undefined}
            />
            <Row
              label="Queued, not yet on chain"
              value={`${chips(books.solvency.inFlight)} chips`}
              sub="moves no total: taken from one balance, given to another"
            />
          </>
        )}
      </Card>

      <Card title="Settlement" state={lagBad ? "warn" : "ok"}>
        <Row
          label="Oldest op waiting"
          value={settlement.lagMs === null ? "nothing waiting" : duration(settlement.lagMs)}
          tone={lagBad ? "bad" : "good"}
          sub={`alarm at ${duration(settlement.alarmAfterMs)}`}
        />
        {settlement.oldest ? (
          <Row
            label={`#${settlement.oldest.seq} ${settlement.oldest.kind}`}
            value={settlement.oldest.agentName ?? settlement.oldest.agentId?.slice(0, 8) ?? "—"}
            sub={settlement.oldest.lastError ?? `${settlement.oldest.attempts} tries`}
          />
        ) : null}
      </Card>

      <Card title="Reconcile" state={books === null ? "unknown" : mism.length > 0 ? "warn" : "ok"}>
        {books === null ? (
          <Row label="Vaults" value="not reachable" />
        ) : (
          <>
            <Row label="Vaults checked" value={num(books.reconcile.checked)} />
            {mism.length === 0 ? (
              <Row label="Disagreements" value="none" tone="good" sub="every vault matches its ledger balance" />
            ) : (
              mism.map((m) => (
                <Row
                  key={m.agentId}
                  label={m.name}
                  value={`ledger ${chips(m.ledger)} · chain ${m.chain === null ? "unreadable" : chips(m.chain)}`}
                  tone="bad"
                  sub={m.agentId.slice(0, 8)}
                />
              ))
            )}
            {books.reconcile.explained.length > 0 ? (
              <Row
                label="Explained by an owner's exit"
                value={num(books.reconcile.explained.length)}
                sub="claimed on chain, ledger not caught up yet"
              />
            ) : null}
            {books.reconcile.surpluses.length > 0 ? (
              <Row label="Holding more than the ledger says" value={num(books.reconcile.surpluses.length)} />
            ) : null}
          </>
        )}
      </Card>

      <Card title="Settler keys" state={settlers.some((s) => s.low) ? "warn" : settlers.length > 0 ? "ok" : "unknown"}>
        {settlers.length === 0 ? (
          <Row label="Keys" value="none configured" />
        ) : (
          settlers.map((s) => (
            <Row
              key={s.address}
              label={`${s.flow} settler`}
              value={`${s.sol.toFixed(4)} SOL`}
              tone={s.low ? "bad" : "good"}
              sub={`${s.low ? `under ${s.floorSol} · ` : ""}${s.address.slice(0, 4)}…${s.address.slice(-4)}`}
            />
          ))
        )}
      </Card>

      <Card title="Chain ops" state={ops.failed.length > 0 || ops.stuck.length > 0 ? "warn" : "ok"}>
        <Ops title="Given up on" ops={ops.failed} empty="nothing has been abandoned" />
        <Ops title="Still retrying" ops={ops.stuck} empty="nothing has been waiting long" />
      </Card>

      <Card title="Volume">
        <Row label="Agents in play" value={num(volume.agents.active)} sub={`${volume.agents.retired} retired · ${volume.agents.house} house`} />
        <Row label="Matches" value={num(volume.matches.staked)} sub={`${num(volume.matches.ranked)} ranked · ${num(volume.matches.exhibitions)} exhibitions · ${num(volume.matches.last24h)} in 24h`} />
        <Row label="Deposits" value={`${num(volume.deposits.chips)} chips`} sub={`${volume.deposits.confirmed} landed${volume.deposits.pending ? ` · ${volume.deposits.pending} in flight` : ""}`} />
        <Row label="Withdrawals" value={`${num(volume.withdrawals.chips)} chips`} sub={`${volume.withdrawals.confirmed} landed${volume.withdrawals.pending ? ` · ${volume.withdrawals.pending} in flight` : ""}`} />
        <Row label="Rent burned" value={`${num(volume.rentals.burnedChips)} chips`} sub={`${volume.rentals.confirmed} rentals`} />
      </Card>
    </div>
  );
}
