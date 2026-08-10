PRAGMA foreign_keys=OFF;--> statement-breakpoint
DELETE FROM `feedback_context`;--> statement-breakpoint
DROP TABLE `feedback_report`;--> statement-breakpoint
DROP TABLE `aggregate`;--> statement-breakpoint
CREATE TABLE `feedback_report` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tracked_item_id` text NOT NULL,
	`agent_item_id` text,
	`result_quality_rating` integer NOT NULL,
	`usage_efficiency_rating` integer NOT NULL,
	`tags_json` text NOT NULL,
	`short_comment` text,
	`effective_weight` real NOT NULL,
	`moderation_status` text DEFAULT 'pending' NOT NULL,
	`fraud_risk_score` real DEFAULT 0 NOT NULL,
	`duplicate_cluster_adjustment` real DEFAULT 1 NOT NULL,
	`included_in_scores` integer DEFAULT true NOT NULL,
	`ip_hash` text,
	`device_hash` text,
	`idempotency_key` text NOT NULL,
	`source` text DEFAULT 'web' NOT NULL,
	`feedback_context_id` text,
	`client_event_id` text,
	`submitted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`tracked_item_id`) REFERENCES `tracked_item`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agent_item_id`) REFERENCES `tracked_item`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "feedback_result_quality_range" CHECK("feedback_report"."result_quality_rating" between 1 and 5),
	CONSTRAINT "feedback_usage_efficiency_range" CHECK("feedback_report"."usage_efficiency_rating" between 1 and 5),
	CONSTRAINT "feedback_comment_length" CHECK("feedback_report"."short_comment" is null or length("feedback_report"."short_comment") <= 500)
);--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_report_user_idempotency_unique` ON `feedback_report` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_report_client_event_unique` ON `feedback_report` (`client_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_report_context_unique` ON `feedback_report` (`feedback_context_id`);--> statement-breakpoint
CREATE INDEX `feedback_report_user_submitted_idx` ON `feedback_report` (`user_id`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `feedback_report_item_submitted_idx` ON `feedback_report` (`tracked_item_id`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `feedback_report_agent_submitted_idx` ON `feedback_report` (`agent_item_id`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `feedback_report_moderation_idx` ON `feedback_report` (`moderation_status`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `feedback_report_ip_submitted_idx` ON `feedback_report` (`ip_hash`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `feedback_report_device_submitted_idx` ON `feedback_report` (`device_hash`,`submitted_at`);--> statement-breakpoint
CREATE TABLE `aggregate` (
	`id` text PRIMARY KEY NOT NULL,
	`tracked_item_id` text NOT NULL,
	`period` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`report_count` integer NOT NULL,
	`weighted_report_count` real NOT NULL,
	`overall_score` real NOT NULL,
	`result_quality_score` real NOT NULL,
	`usage_efficiency_score` real NOT NULL,
	`confidence` real NOT NULL,
	`change` real NOT NULL,
	`state` text NOT NULL,
	`snapshot_day` integer NOT NULL,
	`calculated_at` integer NOT NULL,
	FOREIGN KEY (`tracked_item_id`) REFERENCES `tracked_item`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `aggregate_item_period_day_unique` ON `aggregate` (`tracked_item_id`,`period`,`snapshot_day`);--> statement-breakpoint
CREATE INDEX `aggregate_item_period_calculated_idx` ON `aggregate` (`tracked_item_id`,`period`,`calculated_at`);--> statement-breakpoint
CREATE INDEX `aggregate_item_period_end_idx` ON `aggregate` (`tracked_item_id`,`period`,`period_end`);--> statement-breakpoint
CREATE INDEX `aggregate_period_calculated_item_idx` ON `aggregate` (`period`,`calculated_at`,`tracked_item_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
