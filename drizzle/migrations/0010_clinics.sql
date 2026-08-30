-- Clinics, and the change that makes them possible.
--
-- The load-bearing part is the rebuild of the two lock tables. `game_id` was
-- NOT NULL on both; it becomes nullable, joined by a `clinic_occurrence_id`
-- and a CHECK that exactly one of them is set.
--
-- **One lock table, not two.** Games and clinics compete for the same public
-- courts, so both have to be settled by the same primary key. A separate
-- clinic lock table would let a game and a clinic be sent to the same court at
-- the same hour, which is the failure `court_slot_locks` exists to prevent.
--
-- Additive from the running Worker's point of view, despite the rebuild: no
-- column it reads or writes is dropped, and it keeps writing `game_id` exactly
-- as before. So the usual CI ordering — migrate, then deploy — is safe here,
-- and this does not need the two-release split that migration 0008 did.
--
-- Hand-edited after `drizzle-kit generate`, which got two things wrong:
-- it copied `clinic_occurrence_id` out of the old tables (which have no such
-- column), and it turned foreign keys back on between the two rebuilds.
CREATE TABLE `clinic_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`clinic_id` text NOT NULL,
	`channel` text NOT NULL,
	`sent_at` integer NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`error` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`clinic_id`) REFERENCES `clinics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clinic_notifications_user_clinic_unique` ON `clinic_notifications` (`user_id`,`clinic_id`);--> statement-breakpoint
CREATE INDEX `clinic_notifications_user_idx` ON `clinic_notifications` (`user_id`,`sent_at`);--> statement-breakpoint
CREATE TABLE `clinic_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`clinic_id` text NOT NULL,
	`court_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`calendar_seq` integer DEFAULT 0 NOT NULL,
	`reminded_at` integer,
	FOREIGN KEY (`clinic_id`) REFERENCES `clinics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`court_id`) REFERENCES `courts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clinic_occurrences_clinic_start_unique` ON `clinic_occurrences` (`clinic_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `clinic_occurrences_start_idx` ON `clinic_occurrences` (`starts_at`);--> statement-breakpoint
CREATE INDEX `clinic_occurrences_court_idx` ON `clinic_occurrences` (`court_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `clinic_signups` (
	`id` text PRIMARY KEY NOT NULL,
	`occurrence_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`occurrence_id`) REFERENCES `clinic_occurrences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clinic_signups_occurrence_user_unique` ON `clinic_signups` (`occurrence_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `clinic_signups_user_idx` ON `clinic_signups` (`user_id`);--> statement-breakpoint
CREATE TABLE `clinics` (
	`id` text PRIMARY KEY NOT NULL,
	`organizer_id` text NOT NULL,
	`location_id` text NOT NULL,
	`title` text NOT NULL,
	`description_md` text DEFAULT '' NOT NULL,
	`cost_note` text,
	`hero_key` text,
	`hero_width` integer,
	`hero_height` integer,
	`capacity` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`recur_weekdays` text DEFAULT '[]' NOT NULL,
	`recur_start_minute` integer NOT NULL,
	`recur_end_minute` integer NOT NULL,
	`recur_from` integer NOT NULL,
	`recur_until` integer NOT NULL,
	`created_at` integer NOT NULL,
	`published_at` integer,
	`cancelled_at` integer,
	`cancel_reason` text,
	FOREIGN KEY (`organizer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `clinics_location_idx` ON `clinics` (`location_id`,`status`);--> statement-breakpoint
CREATE INDEX `clinics_organizer_idx` ON `clinics` (`organizer_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_court_slot_locks` (
	`court_id` text NOT NULL,
	`slot_start` integer NOT NULL,
	`game_id` text,
	`clinic_occurrence_id` text,
	PRIMARY KEY(`court_id`, `slot_start`),
	FOREIGN KEY (`court_id`) REFERENCES `courts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`clinic_occurrence_id`) REFERENCES `clinic_occurrences`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "court_slot_locks_one_owner" CHECK(("__new_court_slot_locks"."game_id" IS NULL) <> ("__new_court_slot_locks"."clinic_occurrence_id" IS NULL))
);
--> statement-breakpoint
-- Every existing lock belongs to a game; NULL is the correct clinic id for
-- all of them, and the CHECK above is satisfied because game_id is not null
-- in any pre-existing row.
INSERT INTO `__new_court_slot_locks`("court_id", "slot_start", "game_id", "clinic_occurrence_id") SELECT "court_id", "slot_start", "game_id", NULL FROM `court_slot_locks`;--> statement-breakpoint
DROP TABLE `court_slot_locks`;--> statement-breakpoint
ALTER TABLE `__new_court_slot_locks` RENAME TO `court_slot_locks`;--> statement-breakpoint
CREATE INDEX `court_slot_locks_game_idx` ON `court_slot_locks` (`game_id`);--> statement-breakpoint
CREATE INDEX `court_slot_locks_occurrence_idx` ON `court_slot_locks` (`clinic_occurrence_id`);--> statement-breakpoint
CREATE TABLE `__new_player_slot_locks` (
	`user_id` text NOT NULL,
	`slot_start` integer NOT NULL,
	`game_id` text,
	`clinic_occurrence_id` text,
	PRIMARY KEY(`user_id`, `slot_start`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`clinic_occurrence_id`) REFERENCES `clinic_occurrences`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "player_slot_locks_one_owner" CHECK(("__new_player_slot_locks"."game_id" IS NULL) <> ("__new_player_slot_locks"."clinic_occurrence_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_player_slot_locks`("user_id", "slot_start", "game_id", "clinic_occurrence_id") SELECT "user_id", "slot_start", "game_id", NULL FROM `player_slot_locks`;--> statement-breakpoint
DROP TABLE `player_slot_locks`;--> statement-breakpoint
ALTER TABLE `__new_player_slot_locks` RENAME TO `player_slot_locks`;--> statement-breakpoint
CREATE INDEX `player_slot_locks_game_idx` ON `player_slot_locks` (`game_id`);--> statement-breakpoint
CREATE INDEX `player_slot_locks_occurrence_idx` ON `player_slot_locks` (`clinic_occurrence_id`);--> statement-breakpoint
CREATE INDEX `player_slot_locks_user_idx` ON `player_slot_locks` (`user_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `organizer_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `organizer_note` text;--> statement-breakpoint
ALTER TABLE `users` ADD `organizer_requested_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `notify_clinics` integer DEFAULT true NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=ON;
