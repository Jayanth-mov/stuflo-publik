ALTER TABLE "attachments" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "purpose" text DEFAULT 'attachment' NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "canvas_host" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "course_id" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "course_name" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_student_source_key_unique" ON "attachments" USING btree ("student_id","source_key");--> statement-breakpoint
CREATE INDEX "attachments_student_source_idx" ON "attachments" USING btree ("student_id","source");