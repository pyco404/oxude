-- Exits the server does not co-sign (docs/non-custodial-exit.md).
--
-- One row per agent, mirroring the Exit PDA, which is also one per agent. The
-- chain is the authority for what happened; this table is only the server's
-- record of what it has absorbed.
--
-- "ingested_at" is the column that matters. Between a claim landing on chain
-- and the ledger being debited, the vault legitimately holds less than the
-- ledger says, and the reconciler must say so rather than alarm. Once the
-- ledger catches up there is no shortfall left to explain - so this is not
-- what proves a shortfall is fine, it is what stops a claim the ledger already
-- absorbed from going on explaining a later, real one.
CREATE TABLE "exits" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"requested_slot" bigint NOT NULL,
	"unlock_slot" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"claimed_slot" bigint,
	"claimed_amount" bigint,
	"ingested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exits" ADD CONSTRAINT "exits_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
