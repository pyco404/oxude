"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type RentalStatus } from "@/lib/api";
import { duration, utcMoment } from "@/lib/time";
import { useWallet } from "./wallet-context";

const REFRESH_MS = 60_000;

/**
 * Where the rental stands: running, renewed, expired and renewable, or lapsed.
 *
 * Every rental ends at the season boundary. From 72 hours before it, the
 * owner is asked to renew; once it has passed, an agent that was not renewed
 * is expired - it cannot play - and has 24 hours to be renewed with its record
 * intact before it retires. That window is the one thing here that must be
 * impossible to miss.
 */
export function RentalPanel({
  agentId,
  refreshKey,
  onChanged,
}: {
  agentId: string;
  refreshKey: string;
  /** After a renewal, or when the state changes: the card may need to reload. */
  onChanged: (state: RentalStatus["state"]) => void;
}) {
  const { session } = useWallet();
  const token = session?.token ?? null;
  const [rental, setRental] = useState<RentalStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const lastState = useRef<string | null>(null);

  const show = useCallback((next: RentalStatus) => {
    setRental(next);
    if (lastState.current !== next.state) {
      lastState.current = next.state;
      onChangedRef.current(next.state);
    }
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.agent(token, agentId);
      if (res.rental) show(res.rental);
    } catch {
      // Keep what is on screen; the next refresh tries again.
    }
  }, [token, agentId, show]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load, refreshKey]);

  // The countdowns move between refreshes.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const renew = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      show((await api.renew(token, agentId)).rental);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't reach the server. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  if (!token || !rental || rental.state === "house" || rental.state === "retired") return null;

  const left = (iso: string | null) => (iso ? new Date(iso).getTime() - now : 0);
  const button = (label: string, strong: boolean) => (
    <button
      onClick={() => void renew()}
      disabled={busy}
      className={
        strong
          ? "mt-2 w-full bg-red px-3 py-2 text-[13px] font-medium text-ink disabled:bg-line disabled:text-muted"
          : "mt-2 w-full border border-line px-3 py-2 text-[13px] text-muted hover:border-red hover:text-red"
      }
    >
      {busy ? "Renewing…" : label}
    </button>
  );

  let body: React.ReactNode;
  if (rental.state === "expired") {
    const graceLeft = left(rental.graceEndsAt);
    body = (
      <div className="border border-red px-3 py-3 text-[13px] leading-5 text-red" role="alert">
        <p className="font-medium">
          Expired: renew within {graceLeft > 0 ? duration(graceLeft) : "moments"} to keep it.
        </p>
        <p className="mt-1 text-text">
          The season ended without a renewal, so it can&apos;t play. Renew by {utcMoment(rental.graceEndsAt!)} and it comes
          back with its record, balance, band and floor as they were. After that it retires; its balance stays
          withdrawable.
        </p>
        {rental.canRenew ? button("Renew now", true) : null}
      </div>
    );
  } else if (rental.state === "lapsed") {
    body = (
      <p className="border border-line px-3 py-2 text-[13px] leading-5 text-muted">
        Lapsed: not renewed within 24 hours of the season ending, so it retired. Its record is kept, and its balance can
        be withdrawn below.
      </p>
    );
  } else if (rental.state === "renewed") {
    body = (
      <p className="text-[13px] leading-5 text-muted">
        Renewed: it carries on into the next season, until {utcMoment(rental.endsAt!)}. Autoplay stops at the boundary;
        switch it back on then.
      </p>
    );
  } else {
    const endLeft = left(rental.endsAt);
    body = rental.remind ? (
      <div className="border border-red/60 px-3 py-3 text-[13px] leading-5">
        <p className="text-red">Season {rental.season.number} ends in {duration(endLeft)}.</p>
        <p className="mt-1 text-muted">
          Renew now to carry on into the next season. Free on devnet. If you don&apos;t, it stops at the boundary and you
          have 24 hours to renew before it retires.
        </p>
        {button("Renew for next season", true)}
      </div>
    ) : (
      <>
        <p className="text-[13px] leading-5 text-muted">
          Rented through season {rental.season.number}: ends {utcMoment(rental.endsAt!)}, in {duration(endLeft)}.
        </p>
        {button("Renew for next season", false)}
      </>
    );
  }

  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="text-[11px] uppercase tracking-wider text-muted">Rental</h3>
      <div className="mt-2">{body}</div>
      {error ? <p className="mt-2 text-[12px] text-red">{error}</p> : null}
    </div>
  );
}
