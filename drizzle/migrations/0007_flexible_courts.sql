CREATE TABLE `game_court_options` (
	`game_id` text NOT NULL,
	`court_id` text NOT NULL,
	`rank` integer NOT NULL,
	PRIMARY KEY(`game_id`, `court_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`court_id`) REFERENCES `courts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `game_court_options_game_idx` ON `game_court_options` (`game_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_games` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`court_id` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`format` text NOT NULL,
	`is_mixed` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`min_ntrp` real NOT NULL,
	`max_ntrp` real NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`cancelled_at` integer,
	`reminded_at` integer,
	`host_nudged_at` integer,
	FOREIGN KEY (`host_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`court_id`) REFERENCES `courts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_games`("id", "host_id", "court_id", "starts_at", "ends_at", "format", "is_mixed", "status", "min_ntrp", "max_ntrp", "notes", "created_at", "cancelled_at", "reminded_at", "host_nudged_at") SELECT "id", "host_id", "court_id", "starts_at", "ends_at", "format", "is_mixed", "status", "min_ntrp", "max_ntrp", "notes", "created_at", "cancelled_at", "reminded_at", "host_nudged_at" FROM `games`;--> statement-breakpoint
DROP TABLE `games`;--> statement-breakpoint
ALTER TABLE `__new_games` RENAME TO `games`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `games_start_idx` ON `games` (`starts_at`);--> statement-breakpoint
CREATE INDEX `games_court_idx` ON `games` (`court_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `games_status_idx` ON `games` (`status`,`starts_at`);--> statement-breakpoint
-- Every existing game already has exactly one court, so it becomes that game's
-- single option. Its court_id stays set, which is what "already placed" means
-- under the new model — nothing that is currently booked gets un-booked.
INSERT OR IGNORE INTO `game_court_options` (`game_id`, `court_id`, `rank`)
SELECT `id`, `court_id`, 0 FROM `games` WHERE `court_id` IS NOT NULL;
