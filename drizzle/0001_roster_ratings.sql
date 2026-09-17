ALTER TABLE "agents" DROP CONSTRAINT "agents_preset_xor_policy";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "true_rating" double precision;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "true_rating_roster" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "cumulative_net" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "agents_true_rating_idx" ON "agents" USING btree ("true_rating");--> statement-breakpoint
CREATE INDEX "matches_seq_idx" ON "matches" USING btree ("seq");