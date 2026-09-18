CREATE TABLE "chain_ops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"kind" text NOT NULL,
	"agent_id" uuid,
	"match_id" uuid,
	"from_agent" uuid,
	"to_agent" uuid,
	"amount" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"signature" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chain_ops" ADD CONSTRAINT "chain_ops_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_ops" ADD CONSTRAINT "chain_ops_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_ops" ADD CONSTRAINT "chain_ops_from_agent_agents_id_fk" FOREIGN KEY ("from_agent") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_ops" ADD CONSTRAINT "chain_ops_to_agent_agents_id_fk" FOREIGN KEY ("to_agent") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chain_ops_status_idx" ON "chain_ops" USING btree ("status","seq");--> statement-breakpoint
CREATE INDEX "chain_ops_match_idx" ON "chain_ops" USING btree ("match_id");