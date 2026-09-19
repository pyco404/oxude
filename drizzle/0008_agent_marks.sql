ALTER TABLE "agents" ADD COLUMN "mark" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_mark_unique" UNIQUE("mark");