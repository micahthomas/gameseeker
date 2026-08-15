ALTER TABLE `users` ADD `play_levels` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
-- Backfill: every existing player starts out willing to play at their own
-- level, which is exactly the behaviour they had before this column existed.
UPDATE `users` SET `play_levels` = '[' || CAST(`ntrp` AS TEXT) || ']' WHERE `play_levels` = '[]';
