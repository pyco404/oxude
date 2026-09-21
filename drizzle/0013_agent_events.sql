-- A record of changes to an agent's settings: autoplay on or off, the floor,
-- the band. Written alongside each change; nothing decides anything from it.
-- Added because an agent's row only holds its current settings, so a gap in
-- its play could not be explained after the fact.
CREATE TABLE "agent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_events_agent_idx" ON "agent_events" USING btree ("agent_id","created_at");