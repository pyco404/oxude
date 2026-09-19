CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"amount" integer NOT NULL,
	"remaining" integer NOT NULL,
	"retire" boolean NOT NULL,
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
ALTER TABLE "chain_ops" ADD COLUMN "owner" text;--> statement-breakpoint
ALTER TABLE "chain_ops" ADD COLUMN "withdrawal_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN "withdrawal_id" uuid;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "withdrawals_agent_idx" ON "withdrawals" USING btree ("agent_id","status");