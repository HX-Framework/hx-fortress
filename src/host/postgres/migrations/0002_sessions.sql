CREATE TABLE "hx"."session_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_external_id" text NOT NULL,
	"kind" text NOT NULL,
	"run_id" text,
	"tool_use_id" text,
	"agent_type" text,
	"label" text,
	"worktree_path" text,
	"cwd" text,
	"git_branch" text,
	"model_id" uuid,
	"event_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"est_cost_usd" double precision,
	"bytes_uploaded" bigint DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hx_session_agents_natural_unique" UNIQUE("session_id","agent_external_id")
);
--> statement-breakpoint
CREATE TABLE "hx"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"org_id" uuid,
	"project_id" uuid,
	"repo_id" uuid,
	"model_id" uuid,
	"family" text NOT NULL,
	"session_id" text NOT NULL,
	"ccd_session_id" text,
	"title" text,
	"title_source" text,
	"source_path" text,
	"cwd" text,
	"git_branch" text,
	"entrypoint" text,
	"originator" text,
	"session_origin" text DEFAULT 'local' NOT NULL,
	"attribution_source" text,
	"assigned_at" timestamp with time zone,
	"assigned_by" text,
	"event_count" integer DEFAULT 0 NOT NULL,
	"user_text_count" integer DEFAULT 0 NOT NULL,
	"assistant_count" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"est_cost_usd" double precision,
	"bytes_uploaded" bigint DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"last_user_text" text,
	"last_assistant_text" text,
	"first_event_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hx_sessions_natural_unique" UNIQUE("user_id","family","session_id")
);
--> statement-breakpoint
ALTER TABLE "hx"."session_agents" ADD CONSTRAINT "session_agents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "hx"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."session_agents" ADD CONSTRAINT "session_agents_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "hx"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "hx"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "hx"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."sessions" ADD CONSTRAINT "sessions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "hx"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "hx"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."sessions" ADD CONSTRAINT "sessions_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "hx"."repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."sessions" ADD CONSTRAINT "sessions_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "hx"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hx_session_agents_session_idx" ON "hx"."session_agents" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "hx_sessions_user_activity_idx" ON "hx"."sessions" USING btree ("user_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "hx_sessions_org_activity_idx" ON "hx"."sessions" USING btree ("org_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "hx_sessions_project_activity_idx" ON "hx"."sessions" USING btree ("project_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "hx_sessions_repo_idx" ON "hx"."sessions" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "hx_sessions_model_idx" ON "hx"."sessions" USING btree ("model_id");