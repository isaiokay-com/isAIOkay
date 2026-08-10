CREATE TABLE `cli_turnstile_challenge` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requires_turnstile` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`verified_at` integer,
	`consumed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_id`) REFERENCES `cli_installation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cli_turnstile_challenge_installation_status_idx` ON `cli_turnstile_challenge` (`installation_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `cli_turnstile_challenge_user_expiry_idx` ON `cli_turnstile_challenge` (`user_id`,`expires_at`);