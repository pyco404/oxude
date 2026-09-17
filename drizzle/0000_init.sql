CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"preset_name" text,
	"brief" text,
	"policy_table" jsonb,
	"owner_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "agents_preset_xor_policy" CHECK (("agents"."preset_name" is not null and "agents"."policy_table" is null)
       or ("agents"."preset_name" is null and "agents"."policy_table" is not null))
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_a" uuid NOT NULL,
	"agent_b" uuid NOT NULL,
	"seed" bigint NOT NULL,
	"rules_config" jsonb NOT NULL,
	"winner" text,
	"net_a" integer NOT NULL,
	"net_b" integer NOT NULL,
	"log" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"matches_played" integer DEFAULT 0 NOT NULL,
	"rolling_net_50" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_agent_a_agents_id_fk" FOREIGN KEY ("agent_a") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_agent_b_agents_id_fk" FOREIGN KEY ("agent_b") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "matches_agent_a_idx" ON "matches" USING btree ("agent_a","created_at");--> statement-breakpoint
CREATE INDEX "matches_agent_b_idx" ON "matches" USING btree ("agent_b","created_at");--> statement-breakpoint
CREATE INDEX "matches_created_idx" ON "matches" USING btree ("created_at");