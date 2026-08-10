CREATE TABLE `aggregate` (
	`id` text PRIMARY KEY NOT NULL,
	`tracked_item_id` text NOT NULL,
	`period` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`report_count` integer NOT NULL,
	`weighted_report_count` real NOT NULL,
	`overall_score` real NOT NULL,
	`quality_score` real NOT NULL,
	`speed_score` real NOT NULL,
	`reliability_score` real NOT NULL,
	`value_score` real NOT NULL,
	`confidence` real NOT NULL,
	`change` real NOT NULL,
	`state` text NOT NULL,
	`calculated_at` integer NOT NULL,
	FOREIGN KEY (`tracked_item_id`) REFERENCES `tracked_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aggregate_item_period_window_unique` ON `aggregate` (`tracked_item_id`,`period`,`period_start`,`period_end`);--> statement-breakpoint
CREATE INDEX `aggregate_item_period_calculated_idx` ON `aggregate` (`tracked_item_id`,`period`,`calculated_at`);--> statement-breakpoint
CREATE TABLE `aggregation_job_lock` (
	`key` text PRIMARY KEY NOT NULL,
	`locked_until` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_account_unique` ON `account` (`providerId`,`accountId`);--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`userId`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`token` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`userId`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL,
	`image` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `feedback_report` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tracked_item_id` text NOT NULL,
	`experience_direction` text NOT NULL,
	`quality_rating` integer NOT NULL,
	`speed_rating` integer NOT NULL,
	`reliability_rating` integer NOT NULL,
	`value_rating` integer NOT NULL,
	`task_type` text NOT NULL,
	`usage_recency` text NOT NULL,
	`tags_json` text NOT NULL,
	`short_comment` text,
	`effective_weight` real NOT NULL,
	`moderation_status` text DEFAULT 'pending' NOT NULL,
	`fraud_risk_score` real DEFAULT 0 NOT NULL,
	`included_in_scores` integer DEFAULT true NOT NULL,
	`ip_hash` text,
	`device_hash` text,
	`idempotency_key` text NOT NULL,
	`submitted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`tracked_item_id`) REFERENCES `tracked_item`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "feedback_quality_range" CHECK("feedback_report"."quality_rating" between 1 and 5),
	CONSTRAINT "feedback_speed_range" CHECK("feedback_report"."speed_rating" between 1 and 5),
	CONSTRAINT "feedback_reliability_range" CHECK("feedback_report"."reliability_rating" between 1 and 5),
	CONSTRAINT "feedback_value_range" CHECK("feedback_report"."value_rating" between 1 and 5),
	CONSTRAINT "feedback_comment_length" CHECK("feedback_report"."short_comment" is null or length("feedback_report"."short_comment") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_report_user_idempotency_unique` ON `feedback_report` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `feedback_report_user_submitted_idx` ON `feedback_report` (`user_id`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `feedback_report_item_submitted_idx` ON `feedback_report` (`tracked_item_id`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `feedback_report_moderation_idx` ON `feedback_report` (`moderation_status`,`submitted_at`);--> statement-breakpoint
CREATE TABLE `risk_event` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`kind` text NOT NULL,
	`score` real NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `risk_event_expiry_idx` ON `risk_event` (`expires_at`);--> statement-breakpoint
CREATE INDEX `risk_event_user_idx` ON `risk_event` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `tracked_item` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`provider_name` text NOT NULL,
	`type` text NOT NULL,
	`description` text,
	`logo_url` text,
	`official_url` text NOT NULL,
	`pricing_summary` text,
	`pricing_last_verified_at` integer,
	`version_label` text,
	`release_at` integer,
	`baseline_start_at` integer,
	`baseline_end_at` integer,
	`baseline_locked_at` integer,
	`baseline_method_version` text,
	`release_source_url` text,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracked_item_slug_unique` ON `tracked_item` (`slug`);--> statement-breakpoint
CREATE INDEX `tracked_item_active_sort_idx` ON `tracked_item` (`is_active`,`sort_order`);--> statement-breakpoint
CREATE TABLE `user_profile` (
	`user_id` text PRIMARY KEY NOT NULL,
	`x_user_id` text,
	`x_username` text,
	`x_display_name` text,
	`x_avatar_url` text,
	`x_account_created_at` integer,
	`x_followers_count` integer,
	`x_following_count` integer,
	`x_post_count` integer,
	`x_verified_type` text,
	`x_metadata_last_checked_at` integer,
	`trust_category` text DEFAULT 'probation' NOT NULL,
	`trust_weight` real DEFAULT 0.55 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`first_login_at` integer NOT NULL,
	`last_login_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_profile_x_user_id_unique` ON `user_profile` (`x_user_id`);--> statement-breakpoint
CREATE INDEX `user_profile_status_idx` ON `user_profile` (`status`);