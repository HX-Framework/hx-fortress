ALTER TABLE "hx"."turns" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "hx"."turns" ALTER COLUMN "text" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "hx_turns_kind_idx" ON "hx"."turns" USING btree ("kind");--> statement-breakpoint
UPDATE "hx"."turns" SET "kind" = CASE "role"
    WHEN 'user' THEN 'user_text'
    WHEN 'assistant' THEN 'assistant_text'
    WHEN 'system' THEN 'system_notice'
  END
  WHERE "kind" IS NULL;
