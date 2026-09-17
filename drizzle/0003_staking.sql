CREATE TABLE "elicitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"free" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"agent_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"match_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "max_stake" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "stake" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "elicitations_owner_idx" ON "elicitations" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_agent_idx" ON "ledger" USING btree ("agent_id","seq");--> statement-breakpoint
CREATE INDEX "ledger_match_idx" ON "ledger" USING btree ("match_id");