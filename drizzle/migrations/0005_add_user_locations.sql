CREATE TABLE `user_locations` (
	`user_id` text NOT NULL,
	`location_id` text NOT NULL,
	`rank` integer NOT NULL,
	PRIMARY KEY(`user_id`, `location_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_locations_location_idx` ON `user_locations` (`location_id`);--> statement-breakpoint
-- Backfill before the users table is rebuilt below, because that rebuild is
-- what removes `home_location_id`. A player who had picked a home location
-- keeps it as their single most-preferred one; a player who hadn't gets no
-- rows, which is the same soft "no preference" state.
INSERT OR IGNORE INTO `user_locations` (`user_id`, `location_id`, `rank`)
SELECT `id`, `home_location_id`, 0 FROM `users` WHERE `home_location_id` IS NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`rating_system` text DEFAULT 'NTRP' NOT NULL,
	`rating_value` real NOT NULL,
	`ntrp` real NOT NULL,
	`play_levels` text DEFAULT '[]' NOT NULL,
	`formats` text DEFAULT '[]' NOT NULL,
	`gender` text DEFAULT 'unspecified' NOT NULL,
	`notify_email` integer DEFAULT true NOT NULL,
	`notify_sms` integer DEFAULT false NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`profile_completed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "email", "name", "phone", "rating_system", "rating_value", "ntrp", "play_levels", "formats", "gender", "notify_email", "notify_sms", "is_admin", "profile_completed_at", "created_at") SELECT "id", "email", "name", "phone", "rating_system", "rating_value", "ntrp", "play_levels", "formats", "gender", "notify_email", "notify_sms", "is_admin", "profile_completed_at", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_ntrp_idx` ON `users` (`ntrp`);