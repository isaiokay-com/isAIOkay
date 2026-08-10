DROP INDEX `feedback_context_session_item_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_context_session_unique` ON `feedback_context` (`installation_id`,`session_hash`);