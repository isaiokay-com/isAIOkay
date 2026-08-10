CREATE TABLE `cli_device_authorization` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` text,
	`client_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`approved_at` integer,
	`consumed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cli_device_authorization_code_unique` ON `cli_device_authorization` (`device_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `cli_device_authorization_user_code_unique` ON `cli_device_authorization` (`user_code`);--> statement-breakpoint
CREATE INDEX `cli_device_authorization_expiry_idx` ON `cli_device_authorization` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `cli_installation` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes_json` text DEFAULT '["allowance:read","feedback:write"]' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cli_installation_token_unique` ON `cli_installation` (`token_hash`);--> statement-breakpoint
CREATE INDEX `cli_installation_user_idx` ON `cli_installation` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `cli_installation_expiry_idx` ON `cli_installation` (`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `feedback_context` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`tracked_item_id` text NOT NULL,
	`session_hash` text NOT NULL,
	`tool` text NOT NULL,
	`raw_model_label` text,
	`attribution` text NOT NULL,
	`adapter_version` text NOT NULL,
	`session_duration_bucket` text DEFAULT 'unknown' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_id`) REFERENCES `cli_installation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracked_item_id`) REFERENCES `tracked_item`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_context_session_item_unique` ON `feedback_context` (`installation_id`,`session_hash`,`tracked_item_id`);--> statement-breakpoint
CREATE INDEX `feedback_context_item_tool_idx` ON `feedback_context` (`tracked_item_id`,`tool`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_context_user_idx` ON `feedback_context` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `model_alias` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`raw_label` text NOT NULL,
	`normalized_label` text NOT NULL,
	`tracked_item_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tracked_item_id`) REFERENCES `tracked_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_alias_tool_label_unique` ON `model_alias` (`tool`,`normalized_label`);--> statement-breakpoint
CREATE INDEX `model_alias_item_idx` ON `model_alias` (`tracked_item_id`);--> statement-breakpoint
ALTER TABLE `feedback_report` ADD `source` text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE `feedback_report` ADD `feedback_context_id` text;--> statement-breakpoint
ALTER TABLE `feedback_report` ADD `comparison` text;--> statement-breakpoint
ALTER TABLE `feedback_report` ADD `client_event_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_report_client_event_unique` ON `feedback_report` (`client_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_report_context_unique` ON `feedback_report` (`feedback_context_id`);