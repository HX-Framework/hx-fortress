CREATE SCHEMA IF NOT EXISTS "hx";
--> statement-breakpoint
CREATE TABLE "hx"."devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"name" text,
	"os" text,
	"arch" text,
	"last_seen_at" timestamp with time zone,
	"last_upload_at" timestamp with time zone,
	"sync_total" integer,
	"sync_done" integer,
	"sync_total_bytes" bigint,
	"sync_reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hx_devices_user_device_unique" UNIQUE("user_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "hx"."models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" text NOT NULL,
	"provider" text,
	"display_name" text,
	"input_per_mtok" double precision,
	"output_per_mtok" double precision,
	"cache_read_per_mtok" double precision,
	"cache_write_per_mtok" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hx_models_model_id_unique" UNIQUE("model_id")
);
--> statement-breakpoint
CREATE TABLE "hx"."orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hx_orgs_external_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "hx"."projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hx_projects_org_external_unique" UNIQUE("org_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "hx"."repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hx_repos_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "hx"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hx_users_external_unique" UNIQUE("external_id")
);
--> statement-breakpoint
ALTER TABLE "hx"."devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "hx"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."projects" ADD CONSTRAINT "projects_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "hx"."orgs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hx"."repos" ADD CONSTRAINT "repos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "hx"."projects"("id") ON DELETE set null ON UPDATE no action;