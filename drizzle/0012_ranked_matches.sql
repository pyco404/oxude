-- Only player-versus-player matches count toward the ladder.
--
-- A house preset is fixed and its weaknesses are exactly computable
-- (src/exact.ts), so beating one is not evidence a prize should pay for. House
-- matches still settle on chain and still move balances - they simply earn no
-- ranking.
--
-- `ranked` is stored per match rather than derived from ownership at read
-- time. Agents change hands at auction, and a result has to stay readable as
-- the match it was; deriving it later would rewrite every past match whenever
-- an agent was sold.
--
-- The backfill below is an approximation, and the only one available: it reads
-- *current* ownership, because nothing recorded who owned an agent at the time
-- of a past match. For matches played before any auction existed this is
-- exact. It will be wrong for a match played by an agent that has since been
-- sold or retired to the house, which is a case that cannot arise yet.
ALTER TABLE "matches" ADD COLUMN "ranked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "ranked_matches" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "ranked_net" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "ranked_staked" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "matches" SET "ranked" = true
WHERE "exhibition" = false
  AND EXISTS (SELECT 1 FROM "agents" a WHERE a."id" = "matches"."agent_a" AND a."owner_id" IS NOT NULL)
  AND EXISTS (SELECT 1 FROM "agents" b WHERE b."id" = "matches"."agent_b" AND b."owner_id" IS NOT NULL);--> statement-breakpoint
-- Recompute both sets of figures from the matches now that `ranked` is set.
UPDATE "ratings" r SET
  "ranked_matches" = COALESCE(m."n", 0),
  "ranked_net" = COALESCE(m."net", 0),
  "ranked_staked" = COALESCE(m."staked", 0)
FROM (
  SELECT a."id" AS "agent_id",
         COUNT(*) FILTER (WHERE mm."ranked") AS "n",
         COALESCE(SUM(
           (CASE WHEN mm."agent_a" = a."id" THEN mm."net_a" ELSE mm."net_b" END)
           / (CASE mm."band" WHEN 'A' THEN 0.5 WHEN 'C' THEN 1.5 ELSE 1 END)
         ) FILTER (WHERE mm."ranked"), 0)::bigint AS "net",
         COALESCE(SUM(mm."stake") FILTER (WHERE mm."ranked"), 0)::bigint AS "staked"
  FROM "agents" a
  JOIN "matches" mm ON (mm."agent_a" = a."id" OR mm."agent_b" = a."id") AND mm."exhibition" = false
  GROUP BY a."id"
) m
WHERE r."agent_id" = m."agent_id";
