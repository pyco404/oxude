import type { Character, Traits } from "@/lib/api";
import { Portrait } from "@/app/portrait";

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** How it plays, measured from its matches: one line per trait, or a note until there are enough hands. */
export function TraitList({ traits }: { traits: Traits | undefined }) {
  if (!traits) return null;
  if (traits.note) {
    return (
      <p className="text-[12px] leading-5 text-muted">
        Traits: {traits.note} ({traits.decisions} of 60 decisions so far).
      </p>
    );
  }
  const rows: [string, string][] = [];
  if (traits.bluff) rows.push(["Bluffing", `${traits.bluff.word} · ${pct(traits.bluff.rate)} of weak hands raised`]);
  if (traits.fold) rows.push(["Folding", `${traits.fold.word} · ${pct(traits.fold.rate)} of decisions`]);
  if (traits.aggression) rows.push(["Aggression", `${traits.aggression.word} · raises ${pct(traits.aggression.rate)} of the time it can`]);
  rows.push(["Under pressure", traits.underPressure ? traits.underPressure.word : "not enough hands yet"]);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px] leading-5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The character: face, epithet, bio and measured traits. Presentation only -
 * the decision table plays every hand, and nothing here changes one.
 */
export function CharacterBlock({
  agentId,
  character,
  traits,
  size = 96,
}: {
  agentId: string;
  character: Character | null | undefined;
  traits: Traits | undefined;
  size?: number;
}) {
  return (
    <div className="flex gap-3">
      <Portrait id={agentId} size={size} />
      <div className="min-w-0 flex-1 space-y-2">
        {character ? (
          <>
            <p className="text-[12px] italic text-muted">{character.epithet}</p>
            <p className="text-[13px] leading-5">{character.bio}</p>
          </>
        ) : null}
        <TraitList traits={traits} />
      </div>
    </div>
  );
}
