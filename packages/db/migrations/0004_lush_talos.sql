CREATE TABLE "canvas_course_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"canvas_host" text NOT NULL,
	"course_id" text NOT NULL,
	"course_name" text NOT NULL,
	"course_code" text,
	"term_name" text,
	"course_url" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"syllabus_status" text DEFAULT 'not_scanned' NOT NULL,
	"syllabus_source_url" text,
	"syllabus_attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_systems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"initialized_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvas_initialization_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"canvas_host" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"courses_total" integer DEFAULT 0 NOT NULL,
	"courses_completed" integer DEFAULT 0 NOT NULL,
	"syllabi_found" integer DEFAULT 0 NOT NULL,
	"syllabi_stored" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvas_course_snapshots" ADD CONSTRAINT "canvas_course_snapshots_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_initialization_runs" ADD CONSTRAINT "canvas_initialization_runs_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_course_snapshots_student_course_unique" ON "canvas_course_snapshots" USING btree ("student_id","canvas_host","course_id");--> statement-breakpoint
CREATE INDEX "canvas_course_snapshots_student_active_idx" ON "canvas_course_snapshots" USING btree ("student_id","is_active");--> statement-breakpoint
CREATE INDEX "canvas_course_snapshots_student_term_idx" ON "canvas_course_snapshots" USING btree ("student_id","term_name");--> statement-breakpoint
CREATE INDEX "canvas_initialization_runs_student_created_idx" ON "canvas_initialization_runs" USING btree ("student_id","created_at");--> statement-breakpoint
CREATE INDEX "canvas_initialization_runs_status_idx" ON "canvas_initialization_runs" USING btree ("status");