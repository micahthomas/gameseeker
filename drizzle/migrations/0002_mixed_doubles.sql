ALTER TABLE `game_slots` ADD `seeker_gender` text;--> statement-breakpoint
ALTER TABLE `games` ADD `is_mixed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `gender` text DEFAULT 'unspecified' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `plays_mixed` integer DEFAULT true NOT NULL;