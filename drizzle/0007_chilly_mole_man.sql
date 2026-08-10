CREATE TABLE `catalog_candidate` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized_key` text NOT NULL,
	`provider_name` text NOT NULL,
	`type` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`raw_label` text,
	`version_label` text,
	`release_at` integer,
	`provenance_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`seen_count` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_candidate_normalized_unique` ON `catalog_candidate` (`normalized_key`);--> statement-breakpoint
CREATE INDEX `catalog_candidate_status_seen_idx` ON `catalog_candidate` (`status`,`last_seen_at`);