CREATE TABLE `player_slot_locks` (
	`user_id` text NOT NULL,
	`slot_start` integer NOT NULL,
	`game_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `slot_start`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `player_slot_locks_game_idx` ON `player_slot_locks` (`game_id`);--> statement-breakpoint
CREATE INDEX `player_slot_locks_user_idx` ON `player_slot_locks` (`user_id`);--> statement-breakpoint
-- Backfill every seat already held in a live game, in the same 30-minute
-- granules the app uses.
--
-- INSERT OR IGNORE rather than a plain insert: nothing stopped double-booking
-- before this migration, so the data may already contain overlaps. The first
-- granule wins and the conflicting one is simply not locked — the guard starts
-- applying from now on rather than retroactively invalidating someone's game.
INSERT OR IGNORE INTO `player_slot_locks` (`user_id`, `slot_start`, `game_id`)
WITH RECURSIVE granules(user_id, game_id, slot_start, ends_at) AS (
  SELECT gs.filled_by_user_id, g.id, g.starts_at, g.ends_at
  FROM game_slots gs
  JOIN games g ON g.id = gs.game_id
  WHERE gs.filled_by_user_id IS NOT NULL
    AND g.status IN ('open', 'full')
  UNION ALL
  SELECT user_id, game_id, slot_start + 1800000, ends_at
  FROM granules
  WHERE slot_start + 1800000 < ends_at
)
SELECT user_id, slot_start, game_id FROM granules;
