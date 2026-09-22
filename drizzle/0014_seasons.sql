-- Weekly seasons: Monday 00:00 UTC to the next Monday (src/season.ts).
--
-- Every rental now ends at a season boundary. The backfill opens the season
-- this migration runs in, and every agent already in play joins it: its rental
-- ends at that season's end. Matches from the first season's Monday on are
-- tagged with their season; earlier ones stay null and count only all-time.
-- The current season is worked out from now() rather than written in, so the
-- migration is right whenever it runs.
CREATE TABLE "season_standings" (
	"season" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"ranked_matches" integer NOT NULL,
	"ranked_net" bigint NOT NULL,
	"ranked_staked" bigint NOT NULL,
	"total_matches" integer NOT NULL,
	"total_net" bigint NOT NULL,
	CONSTRAINT "season_standings_season_agent_id_pk" PRIMARY KEY("season","agent_id")
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"key" text PRIMARY KEY NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"chip_rate" bigint
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "retired_reason" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "rental_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "season" text;--> statement-breakpoint
ALTER TABLE "season_standings" ADD CONSTRAINT "season_standings_season_seasons_key_fk" FOREIGN KEY ("season") REFERENCES "public"."seasons"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_standings" ADD CONSTRAINT "season_standings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matches_season_idx" ON "matches" USING btree ("season","ranked");--> statement-breakpoint
INSERT INTO "seasons" ("key", "starts_at", "ends_at")
SELECT to_char(w, 'YYYY-MM-DD'), w AT TIME ZONE 'UTC', (w + interval '7 days') AT TIME ZONE 'UTC'
FROM (SELECT date_trunc('week', now() AT TIME ZONE 'UTC') AS w) cur
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "agents" SET "rental_ends_at" = (SELECT "ends_at" FROM "seasons" ORDER BY "key" DESC LIMIT 1)
WHERE "owner_id" IS NOT NULL AND "retired_at" IS NULL;--> statement-breakpoint
UPDATE "matches" SET "season" = to_char(date_trunc('week', "created_at" AT TIME ZONE 'UTC'), 'YYYY-MM-DD')
WHERE "created_at" >= '2026-09-21T00:00:00Z';--> statement-breakpoint
-- Why each retired agent retired: in full by withdrawal, or it ran out.
UPDATE "agents" SET "retired_reason" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "withdrawals" w
    WHERE w."agent_id" = "agents"."id" AND w."retire" AND w."status" IN ('submitted', 'confirmed')
  ) THEN 'withdrawn'
  ELSE 'broke'
END
WHERE "retired_at" IS NOT NULL;
