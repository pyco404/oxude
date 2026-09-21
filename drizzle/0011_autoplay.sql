-- Autoplay: the server plays a rented agent on a timer.
--
-- Every column defaults to off or null, so this changes nothing about how any
-- existing agent behaves. autoplay starts false for everyone, including agents
-- already rented: an agent that began spending its balance because the server
-- was upgraded would be spending money its owner never authorised.
--
-- autoplay_stopped_reason carries two different things, and the panel has to
-- tell them apart. 'withdrawal' is a hold: autoplay stays true and the agent
-- resumes by itself once the withdrawal lands. 'floor', 'insolvent' and
-- 'retired' are pauses: autoplay is set false and only the owner turns it back
-- on. The column records both; src/db/autoplay.ts is what enforces the
-- difference.
ALTER TABLE "agents" ADD COLUMN "autoplay" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "autoplay_floor" integer;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "autoplay_stopped_reason" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "autoplay_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "autoplay_last_match_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "autoplay_waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "owner_last_seen_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agents_autoplay_idx" ON "agents" USING btree ("autoplay","autoplay_last_match_at");