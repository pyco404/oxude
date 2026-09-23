CREATE TABLE "faucet_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"signature" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "faucet_grants_wallet_idx" ON "faucet_grants" USING btree ("wallet","created_at");
