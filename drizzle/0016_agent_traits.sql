-- Traits measured from play, as raw counts, and the cursor of the pass that
-- keeps them current. Starts empty: the pass reads every past match from the
-- beginning, in batches, on its first runs.
CREATE TABLE "agent_traits" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"decisions" integer DEFAULT 0 NOT NULL,
	"folds" integer DEFAULT 0 NOT NULL,
	"raise_chances" integer DEFAULT 0 NOT NULL,
	"raises" integer DEFAULT 0 NOT NULL,
	"weak_chances" integer DEFAULT 0 NOT NULL,
	"bluffs" integer DEFAULT 0 NOT NULL,
	"pressured" integer DEFAULT 0 NOT NULL,
	"pressured_folds" integer DEFAULT 0 NOT NULL,
	"pressured_raise_chances" integer DEFAULT 0 NOT NULL,
	"pressured_raises" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trait_progress" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_traits" ADD CONSTRAINT "agent_traits_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;