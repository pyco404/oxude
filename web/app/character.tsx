import type { Character, Traits } from "@/lib/api";
import { Portrait } from "@/app/portrait";

const pct = (r: number) => `${Math.round(r * 100)}%`;

/**
 * One measured trait: the word it earned, the rate behind the word, and a bar
 * showing that rate against its whole. The bar is decoration - the word and
 * the figure beside it say everything - so it is hidden from screen readers.
 * `of` is what the rate is a rate of, which the row carries as its title
 * rather than spelling out beside every figure.
 *
 * Ivory on a plain track, deliberately: a trait is neither money nor a result,
 * and the portrait beside it is already carrying the colour.
 */
function TraitBar({ label, word, rate, of }: { label: string; word: string; rate: number; of: string }) {
  return (
    <div title={`${pct(rate)} ${of}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-[11px] uppercase tracking-wider text-muted">{label}</span>
        <span className="min-w-0 truncate text-[12px]">
          {word} <span className="font-mono text-muted">{pct(rate)}</span>
        </span>
      </div>
      <span className="mt-1.5 block h-1.5 bg-line" aria-hidden>
        <span className="block h-1.5 bg-text" style={{ width: `${Math.min(100, Math.round(rate * 100))}%` }} />
      </span>
    </div>
  );
}

/** A trait with a word but no rate to draw: it gets the line without the bar. */
function TraitLine({ label, word }: { label: string; word: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-muted">{label}</span>
      <span className="min-w-0 truncate text-[12px]">{word}</span>
    </div>
  );
}

/** How it plays, measured from its matches, or a note until there are enough hands. */
export function TraitList({ traits }: { traits: Traits | undefined }) {
  if (!traits) return null;
  if (traits.note) {
    return (
      <p className="text-[12px] leading-5 text-muted">
        Traits: {traits.note} (<span className="font-mono">{traits.decisions}</span> of{" "}
        <span className="font-mono">60</span> decisions so far).
      </p>
    );
  }
  return (
    <div className="space-y-2.5">
      {traits.bluff ? (
        <TraitBar label="Bluffs" word={traits.bluff.word} rate={traits.bluff.rate} of="of weak hands raised" />
      ) : null}
      {traits.fold ? (
        <TraitBar label="Folds" word={traits.fold.word} rate={traits.fold.rate} of="of its decisions were folds" />
      ) : null}
      {traits.aggression ? (
        <TraitBar
          label="Aggression"
          word={traits.aggression.word}
          rate={traits.aggression.rate}
          of="of the times it could raise, it did"
        />
      ) : null}
      <TraitLine
        label="Under pressure"
        word={traits.underPressure ? traits.underPressure.word : "not enough hands yet"}
      />
    </div>
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
    <div className="flex gap-4">
      <Portrait id={agentId} size={size} />
      <div className="min-w-0 flex-1 space-y-3">
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
