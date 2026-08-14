CREATE TABLE "hx"."session_facts" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"primary_day" date,
	"active_ms" bigint DEFAULT 0 NOT NULL,
	"user_msgs" integer DEFAULT 0 NOT NULL,
	"assistant_msgs" integer DEFAULT 0 NOT NULL,
	"tool_calls_by_type" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"files_touched" integer DEFAULT 0 NOT NULL,
	"lines_added" integer DEFAULT 0 NOT NULL,
	"lines_removed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "hx"."session_facts" ADD CONSTRAINT "session_facts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "hx"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."session_facts" ADD CONSTRAINT "session_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "hx"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hx_session_facts_user_day_idx" ON "hx"."session_facts" USING btree ("user_id","primary_day");
