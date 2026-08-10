ALTER TABLE `feedback_report` ADD `duplicate_cluster_adjustment` real DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `feedback_report_ip_submitted_idx` ON `feedback_report` (`ip_hash`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `feedback_report_device_submitted_idx` ON `feedback_report` (`device_hash`,`submitted_at`);