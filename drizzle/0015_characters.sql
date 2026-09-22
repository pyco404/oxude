-- Characters: portrait, name origin and bio for each agent. A table of its own,
-- apart from agents, so that nothing which plays or pays can read it. Filled by
-- scripts/backfill-characters.ts for agents that existed before it.
CREATE TABLE "characters" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"name_source" text NOT NULL,
	"epithet" text NOT NULL,
	"bio" text NOT NULL,
	"bio_source" text NOT NULL,
	"portrait_version" integer NOT NULL,
	"portrait_svg" text NOT NULL,
	"portrait_small_svg" text NOT NULL,
	"fingerprint" text NOT NULL,
	"look_key" text NOT NULL,
	"character_type" text NOT NULL,
	"moderation" text DEFAULT 'ok' NOT NULL,
	"moderation_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "characters_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "characters_look_idx" ON "characters" USING btree ("look_key");