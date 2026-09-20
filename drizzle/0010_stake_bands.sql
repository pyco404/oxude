-- Stake bands replace the per-agent ceiling.
--
-- Every agent and every past match becomes a "B". That is not a default chosen
-- for convenience: until now the ceiling never changed what a match was played
-- for, only who an agent met and how much of a result was clamped away, so
-- every agent in this table has been playing band B's stakes (ante 4 / bet 10 /
-- raised 20) all along. Band B is therefore the only value that leaves an
-- existing agent's match economics exactly as its owner found them, and the
-- only one under which a past result still reads as the match it was. Owners
-- move to A or C themselves.
--
-- agents.max_stake is left in place: old matches were shaped by it, so dropping
-- it would make them harder to explain, not easier.
ALTER TABLE "agents" ADD COLUMN "band" text DEFAULT 'B' NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "band" text DEFAULT 'B' NOT NULL;