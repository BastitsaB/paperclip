CREATE TABLE IF NOT EXISTS "global_run_admission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'default' NOT NULL,
	"max_concurrent_runs" integer DEFAULT 20 NOT NULL,
	"emergency_stop_active" boolean DEFAULT false NOT NULL,
	"emergency_stop_reason" text,
	"emergency_stop_actor_type" text,
	"emergency_stop_actor_id" text,
	"emergency_stop_activated_at" timestamp with time zone,
	"authorized_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "global_run_admission_singleton_key_idx" ON "global_run_admission" USING btree ("singleton_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_global_running_status_idx" ON "heartbeat_runs" USING btree ("status") WHERE "heartbeat_runs"."status" = 'running';