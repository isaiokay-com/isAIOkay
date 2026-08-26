ALTER TABLE `feedback_context` ADD `subscription_id` text;
--> statement-breakpoint
CREATE INDEX `feedback_context_subscription_idx` ON `feedback_context` (`subscription_id`,`created_at`);
