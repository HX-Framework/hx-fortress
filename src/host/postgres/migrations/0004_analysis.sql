CREATE TABLE "hx"."analysis_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"description" text,
	"input_schema" jsonb NOT NULL,
	"output_schema" jsonb NOT NULL,
	"projection" jsonb NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hx"."analysis_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"session_id" uuid,
	"path" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"value_text" text,
	"value_number" double precision,
	"value_bool" boolean,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hx"."analysis_run_sessions" (
	"run_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	CONSTRAINT "analysis_run_sessions_run_id_session_id_pk" PRIMARY KEY("run_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "hx"."analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"definition_id" uuid,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"source_scope" jsonb NOT NULL,
	"parameters" jsonb NOT NULL,
	"output" jsonb,
	"output_summary" text,
	"model_id" uuid,
	"usage" jsonb,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hx"."ingest_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"session_id" uuid,
	"family" text,
	"session_id_ext" text,
	"chunk_id" text,
	"dedupe_key" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hx"."usage_rollup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_date" date NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"model_id" uuid,
	"session_count" integer DEFAULT 0 NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_tokens" bigint DEFAULT 0 NOT NULL,
	"est_cost_usd" double precision DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hx_usage_rollup_grain_unique" UNIQUE NULLS NOT DISTINCT("bucket_date","user_id","project_id","model_id")
);
--> statement-breakpoint
ALTER TABLE "hx"."analysis_definitions" ADD CONSTRAINT "analysis_definitions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "hx"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."analysis_facts" ADD CONSTRAINT "analysis_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "hx"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."analysis_facts" ADD CONSTRAINT "analysis_facts_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "hx"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."analysis_facts" ADD CONSTRAINT "analysis_facts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "hx"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."analysis_run_sessions" ADD CONSTRAINT "analysis_run_sessions_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "hx"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."analysis_run_sessions" ADD CONSTRAINT "analysis_run_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "hx"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."analysis_runs" ADD CONSTRAINT "analysis_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "hx"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."analysis_runs" ADD CONSTRAINT "analysis_runs_definition_id_analysis_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "hx"."analysis_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."analysis_runs" ADD CONSTRAINT "analysis_runs_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "hx"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."ingest_events" ADD CONSTRAINT "ingest_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "hx"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."ingest_events" ADD CONSTRAINT "ingest_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "hx"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."usage_rollup" ADD CONSTRAINT "usage_rollup_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "hx"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."usage_rollup" ADD CONSTRAINT "usage_rollup_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "hx"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."usage_rollup" ADD CONSTRAINT "usage_rollup_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "hx"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hx_analysis_definitions_user_kind_idx" ON "hx"."analysis_definitions" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "hx_analysis_facts_user_key_idx" ON "hx"."analysis_facts" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "hx_analysis_facts_run_idx" ON "hx"."analysis_facts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "hx_analysis_facts_session_idx" ON "hx"."analysis_facts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "hx_analysis_run_sessions_session_idx" ON "hx"."analysis_run_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "hx_analysis_runs_user_status_idx" ON "hx"."analysis_runs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "hx_analysis_runs_user_started_idx" ON "hx"."analysis_runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hx_ingest_events_dedupe_unique" ON "hx"."ingest_events" USING btree ("dedupe_key") WHERE "hx"."ingest_events"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "hx_ingest_events_user_created_idx" ON "hx"."ingest_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "hx_ingest_events_status_created_idx" ON "hx"."ingest_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "hx_ingest_events_session_created_idx" ON "hx"."ingest_events" USING btree ("session_id","created_at");