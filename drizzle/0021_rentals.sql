CREATE TABLE "rentals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"fee" bigint NOT NULL,
	"deposit" bigint NOT NULL,
	"salt" text NOT NULL,
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
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "rentals_agent_idx" ON "rentals" USING btree ("agent_id","status");
--> statement-breakpoint
CREATE INDEX "rentals_status_idx" ON "rentals" USING btree ("status");
