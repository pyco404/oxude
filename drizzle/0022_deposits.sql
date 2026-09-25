CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"prepared_tx" text NOT NULL,
	"signed_tx" text,
	"last_valid_block_height" bigint NOT NULL,
	"signature" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "deposits_agent_idx" ON "deposits" USING btree ("agent_id","status");
--> statement-breakpoint
CREATE INDEX "deposits_status_idx" ON "deposits" USING btree ("status");
