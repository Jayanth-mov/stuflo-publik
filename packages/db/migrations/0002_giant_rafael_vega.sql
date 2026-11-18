DROP TABLE IF EXISTS "agent_registry";--> statement-breakpoint
DROP TABLE IF EXISTS "channel_connections";--> statement-breakpoint
ALTER TABLE "operational_alerts" DROP COLUMN IF EXISTS "notification_sent_at";
