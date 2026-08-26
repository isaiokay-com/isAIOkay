CREATE TABLE `subscription_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`provider_name` text NOT NULL,
	`name` text NOT NULL,
	`billing_period` text DEFAULT 'monthly' NOT NULL,
	`price_micros` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`official_url` text NOT NULL,
	`terms_version` text,
	`terms_last_verified_at` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_plan_slug_unique` ON `subscription_plan` (`slug`);
--> statement-breakpoint
CREATE INDEX `subscription_plan_active_provider_idx` ON `subscription_plan` (`is_active`,`provider_name`,`name`);
--> statement-breakpoint
INSERT OR IGNORE INTO `subscription_plan`
  (`id`,`slug`,`provider_name`,`name`,`billing_period`,`price_micros`,`currency`,`official_url`,`terms_version`,`terms_last_verified_at`,`is_active`,`created_at`,`updated_at`)
VALUES
  ('20000000-0000-4000-8000-000000000001','chatgpt-plus','OpenAI','ChatGPT Plus','monthly',20000000,'USD','https://openai.com/chatgpt/pricing','2026-08-20',1787616000000,1,1787616000000,1787616000000),
  ('20000000-0000-4000-8000-000000000002','chatgpt-pro-100','OpenAI','ChatGPT Pro $100','monthly',100000000,'USD','https://help.openai.com/en/articles/6825453-chatgpt-release-notes','2026-08-20',1787616000000,1,1787616000000,1787616000000),
  ('20000000-0000-4000-8000-000000000003','chatgpt-pro-200','OpenAI','ChatGPT Pro $200','monthly',200000000,'USD','https://help.openai.com/en/articles/6825453-chatgpt-release-notes','2026-08-20',1787616000000,1,1787616000000,1787616000000),
  ('20000000-0000-4000-8000-000000000004','claude-pro','Anthropic','Claude Pro','monthly',20000000,'USD','https://support.claude.com/en/articles/11049762-choose-a-claude-plan','2026-05-19',1787616000000,1,1787616000000,1787616000000),
  ('20000000-0000-4000-8000-000000000005','claude-max-5x','Anthropic','Claude Max 5x','monthly',100000000,'USD','https://support.claude.com/en/articles/11049741-what-is-the-max-plan','2026-08',1787616000000,1,1787616000000,1787616000000),
  ('20000000-0000-4000-8000-000000000006','claude-max-20x','Anthropic','Claude Max 20x','monthly',200000000,'USD','https://support.claude.com/en/articles/11049741-what-is-the-max-plan','2026-08',1787616000000,1,1787616000000,1787616000000),
  ('20000000-0000-4000-8000-000000000007','supergrok','xAI','SuperGrok','monthly',30000000,'USD','https://x.ai/pricing','2026-08-25',1787616000000,1,1787616000000,1787616000000),
  ('20000000-0000-4000-8000-000000000008','supergrok-plus','xAI','SuperGrok Plus','monthly',100000000,'USD','https://x.ai/pricing','2026-08-25',1787616000000,1,1787616000000,1787616000000),
  ('20000000-0000-4000-8000-000000000009','github-copilot-pro','GitHub','GitHub Copilot Pro','monthly',10000000,'USD','https://github.com/features/copilot/plans','2026-08-25',1787616000000,1,1787616000000,1787616000000),
  ('20000000-0000-4000-8000-000000000010','github-copilot-pro-plus','GitHub','GitHub Copilot Pro+','monthly',39000000,'USD','https://github.com/features/copilot/plans','2026-08-25',1787616000000,1,1787616000000,1787616000000),
  ('20000000-0000-4000-8000-000000000011','github-copilot-max','GitHub','GitHub Copilot Max','monthly',100000000,'USD','https://github.com/features/copilot/plans','2026-08-25',1787616000000,1,1787616000000,1787616000000);
--> statement-breakpoint
CREATE TABLE `user_subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plan_id` text,
	`client_subscription_id` text NOT NULL,
	`provider_name` text NOT NULL,
	`plan_label` text NOT NULL,
	`billing_period` text DEFAULT 'monthly' NOT NULL,
	`price_micros` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`aggregate_consent` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `subscription_plan`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_subscription_client_unique` ON `user_subscription` (`user_id`,`client_subscription_id`);
--> statement-breakpoint
CREATE INDEX `user_subscription_plan_consent_idx` ON `user_subscription` (`plan_id`,`aggregate_consent`,`ended_at`);
--> statement-breakpoint
CREATE INDEX `user_subscription_user_active_idx` ON `user_subscription` (`user_id`,`ended_at`);
--> statement-breakpoint
CREATE TABLE `usage_slice` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`client_event_id` text NOT NULL,
	`tool` text NOT NULL,
	`provider_name` text NOT NULL,
	`session_hash` text,
	`request_hash` text,
	`requested_model` text,
	`reported_model` text NOT NULL,
	`model_family` text,
	`model_version` text,
	`reasoning_effort` text,
	`model_variant` text,
	`service_tier` text,
	`query_source` text DEFAULT 'unknown' NOT NULL,
	`granularity` text NOT NULL,
	`attribution_quality` text NOT NULL,
	`token_attribution_quality` text NOT NULL,
	`model_attribution_quality` text NOT NULL,
	`effort_attribution_quality` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`reported_total_tokens` integer,
	`observed_at` integer NOT NULL,
	`collector_version` text NOT NULL,
	`ingested_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_id`) REFERENCES `cli_installation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `user_subscription`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `usage_slice_token_nonnegative` CHECK (`input_tokens` >= 0 and `cache_read_tokens` >= 0 and `cache_write_tokens` >= 0 and `output_tokens` >= 0 and `reasoning_tokens` >= 0),
	CONSTRAINT `usage_slice_has_tokens` CHECK (`input_tokens` + `cache_read_tokens` + `cache_write_tokens` + `output_tokens` + `reasoning_tokens` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_slice_installation_event_unique` ON `usage_slice` (`installation_id`,`client_event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_slice_installation_request_unique` ON `usage_slice` (`installation_id`,`request_hash`);
--> statement-breakpoint
CREATE INDEX `usage_slice_subscription_observed_idx` ON `usage_slice` (`subscription_id`,`observed_at`);
--> statement-breakpoint
CREATE INDEX `usage_slice_plan_dimensions_idx` ON `usage_slice` (`provider_name`,`reported_model`,`reasoning_effort`,`observed_at`);
--> statement-breakpoint
CREATE INDEX `usage_slice_user_observed_idx` ON `usage_slice` (`user_id`,`observed_at`);
--> statement-breakpoint
CREATE TABLE `quota_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`client_event_id` text NOT NULL,
	`quota_scope` text NOT NULL,
	`window_kind` text NOT NULL,
	`used_percent` real,
	`remaining_percent` real,
	`reset_at` integer,
	`attribution_quality` text NOT NULL,
	`observed_at` integer NOT NULL,
	`collector_version` text NOT NULL,
	`ingested_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_id`) REFERENCES `cli_installation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `user_subscription`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `quota_snapshot_used_range` CHECK (`used_percent` is null or (`used_percent` >= 0 and `used_percent` <= 100)),
	CONSTRAINT `quota_snapshot_remaining_range` CHECK (`remaining_percent` is null or (`remaining_percent` >= 0 and `remaining_percent` <= 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quota_snapshot_installation_event_unique` ON `quota_snapshot` (`installation_id`,`client_event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `quota_snapshot_installation_observation_unique` ON `quota_snapshot` (`installation_id`,`subscription_id`,`quota_scope`,`observed_at`);
--> statement-breakpoint
CREATE INDEX `quota_snapshot_subscription_scope_observed_idx` ON `quota_snapshot` (`subscription_id`,`quota_scope`,`observed_at`);
--> statement-breakpoint
CREATE TABLE `model_price` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_name` text NOT NULL,
	`model_key` text NOT NULL,
	`display_name` text NOT NULL,
	`input_micros_per_million` integer NOT NULL,
	`cache_read_micros_per_million` integer NOT NULL,
	`cache_write_micros_per_million` integer NOT NULL,
	`output_micros_per_million` integer NOT NULL,
	`reasoning_micros_per_million` integer NOT NULL,
	`source_url` text NOT NULL,
	`effective_from` integer NOT NULL,
	`effective_to` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_price_provider_model_effective_unique` ON `model_price` (`provider_name`,`model_key`,`effective_from`);
--> statement-breakpoint
CREATE INDEX `model_price_lookup_idx` ON `model_price` (`provider_name`,`model_key`,`effective_from`,`effective_to`);
--> statement-breakpoint
CREATE TABLE `subscription_aggregate` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`period` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`contributor_count` integer NOT NULL,
	`subscription_count` integer NOT NULL,
	`usage_slice_count` integer NOT NULL,
	`exact_slice_count` integer NOT NULL,
	`complete_window_count` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`reasoning_tokens` integer NOT NULL,
	`observed_token_total` integer NOT NULL,
	`median_tokens_per_subscription` integer,
	`api_equivalent_micros` integer,
	`allowance_value_score` real,
	`satisfaction_score` real,
	`satisfaction_count` integer DEFAULT 0 NOT NULL,
	`quality_adjusted_value_score` real,
	`confidence` real NOT NULL,
	`change_percent` real,
	`methodology_version` text NOT NULL,
	`snapshot_day` integer NOT NULL,
	`calculated_at` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `subscription_plan`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_aggregate_plan_period_day_unique` ON `subscription_aggregate` (`plan_id`,`period`,`snapshot_day`);
--> statement-breakpoint
CREATE INDEX `subscription_aggregate_period_calculated_idx` ON `subscription_aggregate` (`period`,`calculated_at`,`plan_id`);
--> statement-breakpoint
CREATE TABLE `subscription_dimension_aggregate` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`period` text NOT NULL,
	`reported_model` text NOT NULL,
	`reasoning_effort` text NOT NULL,
	`query_source` text NOT NULL,
	`contributor_count` integer NOT NULL,
	`usage_slice_count` integer NOT NULL,
	`exact_slice_count` integer NOT NULL,
	`observed_token_total` integer NOT NULL,
	`api_equivalent_micros` integer,
	`snapshot_day` integer NOT NULL,
	`calculated_at` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `subscription_plan`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_dimension_plan_period_key_day_unique` ON `subscription_dimension_aggregate` (`plan_id`,`period`,`reported_model`,`reasoning_effort`,`query_source`,`snapshot_day`);
--> statement-breakpoint
CREATE INDEX `subscription_dimension_period_day_idx` ON `subscription_dimension_aggregate` (`period`,`snapshot_day`,`plan_id`);
--> statement-breakpoint
UPDATE `cli_installation`
SET `scopes_json` = '["allowance:read","feedback:write","subscriptions:write","usage:write","usage:read"]'
WHERE `revoked_at` IS NULL;
