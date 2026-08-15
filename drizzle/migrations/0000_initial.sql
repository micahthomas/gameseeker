CREATE TABLE `availability_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`kind` text DEFAULT 'available' NOT NULL,
	`format_pref` text DEFAULT 'either' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `avail_blocks_user_time_idx` ON `availability_blocks` (`user_id`,`starts_at`,`ends_at`);--> statement-breakpoint
CREATE TABLE `availability_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`start_minute` integer NOT NULL,
	`end_minute` integer NOT NULL,
	`format_pref` text DEFAULT 'either' NOT NULL,
	`effective_from` integer NOT NULL,
	`effective_until` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `avail_rules_user_idx` ON `availability_rules` (`user_id`,`weekday`);--> statement-breakpoint
CREATE TABLE `court_slot_locks` (
	`court_id` text NOT NULL,
	`slot_start` integer NOT NULL,
	`game_id` text NOT NULL,
	PRIMARY KEY(`court_id`, `slot_start`),
	FOREIGN KEY (`court_id`) REFERENCES `courts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `court_slot_locks_game_idx` ON `court_slot_locks` (`game_id`);--> statement-breakpoint
CREATE TABLE `courts` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`surface` text DEFAULT 'hard' NOT NULL,
	`has_lights` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `courts_location_idx` ON `courts` (`location_id`);--> statement-breakpoint
CREATE TABLE `game_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`slot_index` integer NOT NULL,
	`kind` text NOT NULL,
	`invited_user_id` text,
	`seeker_ntrp` real,
	`filled_by_user_id` text,
	`filled_at` integer,
	`status` text DEFAULT 'open' NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`filled_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_slots_game_index_unique` ON `game_slots` (`game_id`,`slot_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `game_slots_one_seat_per_player` ON `game_slots` (`game_id`,`filled_by_user_id`) WHERE "game_slots"."filled_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `game_slots_open_idx` ON `game_slots` (`status`,`seeker_ntrp`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`court_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`format` text NOT NULL,
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
CREATE INDEX `games_start_idx` ON `games` (`starts_at`);--> statement-breakpoint
CREATE INDEX `games_court_idx` ON `games` (`court_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `games_status_idx` ON `games` (`status`,`starts_at`);--> statement-breakpoint
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address` text,
	`lat` real,
	`lng` real,
	`kind` text DEFAULT 'public_park' NOT NULL,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `magic_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `magic_tokens_expiry_idx` ON `magic_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`game_id` text NOT NULL,
	`slot_id` text,
	`seeker_ntrp` real,
	`channel` text NOT NULL,
	`claim_token` text NOT NULL,
	`sent_at` integer NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`responded_at` integer,
	`error` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`slot_id`) REFERENCES `game_slots`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_claim_token_unique` ON `notifications` (`claim_token`);--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`sent_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_user_game_unique` ON `notifications` (`user_id`,`game_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`rating_system` text DEFAULT 'NTRP' NOT NULL,
	`rating_value` real NOT NULL,
	`ntrp` real NOT NULL,
	`plays_singles` integer DEFAULT true NOT NULL,
	`plays_doubles` integer DEFAULT true NOT NULL,
	`notify_email` integer DEFAULT true NOT NULL,
	`notify_sms` integer DEFAULT false NOT NULL,
	`home_location_id` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`profile_completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`home_location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_ntrp_idx` ON `users` (`ntrp`);