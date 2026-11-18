CREATE TABLE "operational_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notification_sent_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "student_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"category" text DEFAULT 'preference' NOT NULL,
	"content" text NOT NULL,
	"source" text DEFAULT 'student' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "student_profiles" (
	"student_id" uuid PRIMARY KEY NOT NULL,
	"preferred_name" text,
	"communication_style" text DEFAULT 'balanced' NOT NULL,
	"response_verbosity" text DEFAULT 'balanced' NOT NULL,
	"learning_goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"study_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"memory_summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "student_memories" ADD CONSTRAINT "student_memories_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operational_alerts_dedupe_key_unique" ON "operational_alerts" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "operational_alerts_status_triggered_idx" ON "operational_alerts" USING btree ("status","last_triggered_at");--> statement-breakpoint
CREATE INDEX "student_memories_student_status_idx" ON "student_memories" USING btree ("student_id","status");--> statement-breakpoint
CREATE INDEX "student_memories_student_updated_idx" ON "student_memories" USING btree ("student_id","updated_at");