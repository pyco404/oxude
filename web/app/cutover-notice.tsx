"use client";

/**
 * The old settlement program is closing. Shown to anyone holding an agent on
 * it, and on the rent screen while renting is paused.
 *
 * It says the date twice — when the agent stops playing, and how long the money
 * can still be taken — because those are different days and the second is the
 * one somebody loses by not reading.
 */
export function CutoverNotice({
  cutover,
  agentName,
}: {
  cutover: { endsAt: string; withdrawableUntil: string };
  /** Named when this is about a particular agent, absent on the rent screen. */
  agentName?: string;
}) {
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="rounded-panel border border-gold bg-panel-2 px-3 py-3 text-[13px] leading-5" role="status">
      <p className="font-medium text-gold">
        {agentName ? `${agentName} retires ${when(cutover.endsAt)}` : "Renting is paused"}
      </p>
      <p className="mt-2 text-muted">
        Oxude is moving to a new settlement program. On it you fund your agent with your own deposit instead of being
        handed a starting balance, and renting costs a fee.
      </p>
      {agentName ? (
        <p className="mt-2 text-muted">
          It keeps playing until then. Its record is kept, and{" "}
          <span className="text-ink">its balance can be withdrawn until {when(cutover.withdrawableUntil)}</span> — after
          that it lapses. Rent again on the new program when it opens to you.
        </p>
      ) : (
        <p className="mt-2 text-muted">
          Agents rented before the move keep playing until {when(cutover.endsAt)}, and their balances can be withdrawn
          for a day after.
        </p>
      )}
    </div>
  );
}
