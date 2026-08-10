-- Authentication provider reset: X identities cannot be safely translated to
-- GitHub identities. The project is pre-release, so remove reports and auth
-- state together instead of attaching historical feedback to the wrong user.
DELETE FROM `feedback_report`;--> statement-breakpoint
DELETE FROM `aggregate`;--> statement-breakpoint
DELETE FROM `catalog_candidate` WHERE `source` = 'x';--> statement-breakpoint
DELETE FROM `user`;--> statement-breakpoint
DROP INDEX `user_profile_x_user_id_unique`;--> statement-breakpoint
DROP INDEX `user_profile_x_username_unique`;--> statement-breakpoint
ALTER TABLE `user_profile` ADD `github_user_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `user_profile` ADD `github_username` text NOT NULL;--> statement-breakpoint
ALTER TABLE `user_profile` ADD `github_display_name` text;--> statement-breakpoint
ALTER TABLE `user_profile` ADD `github_avatar_url` text;--> statement-breakpoint
ALTER TABLE `user_profile` ADD `github_account_created_at` integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `user_profile_github_user_id_unique` ON `user_profile` (`github_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_profile_github_username_unique` ON `user_profile` (lower("github_username"));--> statement-breakpoint
ALTER TABLE `user_profile` DROP COLUMN `x_user_id`;--> statement-breakpoint
ALTER TABLE `user_profile` DROP COLUMN `x_display_name`;--> statement-breakpoint
ALTER TABLE `user_profile` DROP COLUMN `x_avatar_url`;--> statement-breakpoint
ALTER TABLE `user_profile` DROP COLUMN `x_account_created_at`;--> statement-breakpoint
ALTER TABLE `user_profile` DROP COLUMN `x_followers_count`;--> statement-breakpoint
ALTER TABLE `user_profile` DROP COLUMN `x_following_count`;--> statement-breakpoint
ALTER TABLE `user_profile` DROP COLUMN `x_post_count`;--> statement-breakpoint
ALTER TABLE `user_profile` DROP COLUMN `x_verified_type`;--> statement-breakpoint
ALTER TABLE `user_profile` DROP COLUMN `x_metadata_last_checked_at`;--> statement-breakpoint
ALTER TABLE `user` ADD `githubUsername` text;--> statement-breakpoint
ALTER TABLE `user` ADD `githubAccountCreatedAt` integer;--> statement-breakpoint
ALTER TABLE `user` DROP COLUMN `xUsername`;
