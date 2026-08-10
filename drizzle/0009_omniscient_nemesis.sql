UPDATE `user`
SET `xUsername` = NULL
WHERE `id` IN (
	SELECT `user_id` FROM `user_profile`
	WHERE `x_username` IS NOT NULL
	  AND (
		length(`x_username`) NOT BETWEEN 1 AND 15
		OR `x_username` GLOB '*[^A-Za-z0-9_]*'
	  )
);
--> statement-breakpoint
UPDATE `user_profile`
SET `x_username` = NULL, `x_metadata_last_checked_at` = NULL
WHERE `x_username` IS NOT NULL
  AND (
    length(`x_username`) NOT BETWEEN 1 AND 15
    OR `x_username` GLOB '*[^A-Za-z0-9_]*'
);
--> statement-breakpoint
WITH `ranked_usernames` AS (
	SELECT
		`user_id`,
		row_number() OVER (
			PARTITION BY lower(`x_username`)
			ORDER BY `x_metadata_last_checked_at` DESC, `last_login_at` DESC, `user_id` ASC
		) AS `username_rank`
	FROM `user_profile`
	WHERE `x_username` IS NOT NULL
)
UPDATE `user`
SET `xUsername` = NULL
WHERE `id` IN (
	SELECT `user_id` FROM `ranked_usernames` WHERE `username_rank` > 1
);
--> statement-breakpoint
WITH `ranked_usernames` AS (
	SELECT
		`user_id`,
		row_number() OVER (
			PARTITION BY lower(`x_username`)
			ORDER BY `x_metadata_last_checked_at` DESC, `last_login_at` DESC, `user_id` ASC
		) AS `username_rank`
	FROM `user_profile`
	WHERE `x_username` IS NOT NULL
)
UPDATE `user_profile`
SET `x_username` = NULL, `x_metadata_last_checked_at` = NULL
WHERE `user_id` IN (
	SELECT `user_id` FROM `ranked_usernames` WHERE `username_rank` > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_profile_x_username_unique` ON `user_profile` (lower("x_username"));
