-- Prize placement: the second of the two orderings a frozen season carries.
--
-- "rank" stays what it has always been - ranked net won, normalised onto band
-- B - and is what the ladder shows. "prize_rank" is placement for prize
-- purposes: ranked net per chip staked, best first, and null for an agent
-- short of the minimum match count (src/db/standings.ts). The two are
-- different orderings of the same season and are labelled differently
-- everywhere they are shown.
--
-- "ranked_net_real" is the numerator the per-chip figure divides: the chips
-- those ranked matches actually moved, not normalised. The ladder's
-- "ranked_net" cannot serve - it has already had the band correction applied,
-- and dividing it by chips staked would apply that correction twice.
ALTER TABLE "season_standings" ADD COLUMN "ranked_net_real" bigint;--> statement-breakpoint
ALTER TABLE "season_standings" ADD COLUMN "prize_rank" integer;--> statement-breakpoint
-- Backfill from the matches themselves, the same arithmetic the code does.
-- No season has closed as this ships, so this finds nothing; it is here so
-- that a database restored from anywhere comes out the same.
UPDATE "season_standings" ss SET "ranked_net_real" = COALESCE((
  SELECT sum(n) FROM (
    SELECT m."net_a" AS n FROM "matches" m
      WHERE m."season" = ss."season" AND m."agent_a" = ss."agent_id" AND m."ranked" AND NOT m."exhibition"
    UNION ALL
    SELECT m."net_b" FROM "matches" m
      WHERE m."season" = ss."season" AND m."agent_b" = ss."agent_id" AND m."ranked" AND NOT m."exhibition"
  ) s
), 0);--> statement-breakpoint
ALTER TABLE "season_standings" ALTER COLUMN "ranked_net_real" SET NOT NULL;--> statement-breakpoint
-- prize_rank stays null for any season closed before this. Placement did not
-- exist then and nothing was paid on one, and re-deriving it here would mean
-- writing the minimum and the tie-break out a second time, in SQL, where they
-- could drift from the code that is meant to own them.
CREATE INDEX "season_standings_prize_idx" ON "season_standings" USING btree ("season","prize_rank");
