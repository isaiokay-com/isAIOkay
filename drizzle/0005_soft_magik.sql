ALTER TABLE `feedback_report` ADD `agent_item_id` text REFERENCES tracked_item(id);--> statement-breakpoint
CREATE INDEX `feedback_report_agent_submitted_idx` ON `feedback_report` (`agent_item_id`,`submitted_at`);--> statement-breakpoint
ALTER TABLE `user_profile` ADD `public_profile_enabled` integer DEFAULT false NOT NULL;