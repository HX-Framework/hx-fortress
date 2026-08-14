CREATE TABLE "hx"."tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid,
	"session_id" uuid NOT NULL,
	"agent_id" uuid,
	"tool_use_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"input" jsonb,
	"result" jsonb,
	"is_error" boolean DEFAULT false NOT NULL,
	"status" text,
	"event_ts" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hx_tool_calls_natural_unique" UNIQUE("session_id","tool_use_id")
);
--> statement-breakpoint
CREATE TABLE "hx"."turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_id" uuid,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"model_id" uuid,
	"event_ts" timestamp with time zone,
	"text" text NOT NULL,
	"raw_event" jsonb,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_creation_tokens" integer,
	"est_cost_usd" double precision,
	"text_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "hx"."turns"."text")) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hx_turns_lane_seq_unique" UNIQUE NULLS NOT DISTINCT("session_id","agent_id","seq")
);
--> statement-breakpoint
ALTER TABLE "hx"."tool_calls" ADD CONSTRAINT "tool_calls_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "hx"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."tool_calls" ADD CONSTRAINT "tool_calls_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "hx"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."tool_calls" ADD CONSTRAINT "tool_calls_agent_id_session_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "hx"."session_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."turns" ADD CONSTRAINT "turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "hx"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."turns" ADD CONSTRAINT "turns_agent_id_session_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "hx"."session_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."turns" ADD CONSTRAINT "turns_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "hx"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hx_tool_calls_session_tool_idx" ON "hx"."tool_calls" USING btree ("session_id","tool_name");--> statement-breakpoint
CREATE INDEX "hx_tool_calls_tool_idx" ON "hx"."tool_calls" USING btree ("tool_name");--> statement-breakpoint
CREATE INDEX "hx_turns_tsv_idx" ON "hx"."turns" USING gin ("text_tsv");--> statement-breakpoint
CREATE INDEX "hx_turns_text_trgm_idx" ON "hx"."turns" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "hx_turns_session_seq_idx" ON "hx"."turns" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "hx_turns_role_idx" ON "hx"."turns" USING btree ("role");--> statement-breakpoint
CREATE INDEX "hx_turns_model_idx" ON "hx"."turns" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "hx_turns_event_ts_idx" ON "hx"."turns" USING btree ("event_ts");