CREATE TABLE `deleted_identity` (
	`identity_hash` text PRIMARY KEY NOT NULL,
	`deleted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `deleted_profile_blocks_user_update`
BEFORE UPDATE ON `user`
WHEN EXISTS (SELECT 1 FROM `user_profile` WHERE `user_id` = OLD.`id` AND `status` = 'deleted')
BEGIN
	SELECT RAISE(ABORT, 'deleted account is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `deleted_profile_blocks_account_insert`
BEFORE INSERT ON `account`
WHEN EXISTS (SELECT 1 FROM `user_profile` WHERE `user_id` = NEW.`userId` AND `status` = 'deleted')
BEGIN
	SELECT RAISE(ABORT, 'deleted account cannot create access data');
END;
--> statement-breakpoint
CREATE TRIGGER `deleted_profile_blocks_session_insert`
BEFORE INSERT ON `session`
WHEN EXISTS (SELECT 1 FROM `user_profile` WHERE `user_id` = NEW.`userId` AND `status` = 'deleted')
BEGIN
	SELECT RAISE(ABORT, 'deleted account cannot create access data');
END;
--> statement-breakpoint
CREATE TRIGGER `deleted_profile_blocks_reactivation`
BEFORE UPDATE OF `status` ON `user_profile`
WHEN OLD.`status` = 'deleted' AND NEW.`status` != 'deleted'
BEGIN
	SELECT RAISE(ABORT, 'deleted account cannot be reactivated');
END;
