-- Replace `users.gender` with `users.division`, and `game_slots.seeker_gender`
-- with `game_slots.seeker_division`.
--
-- The app only ever used gender to answer one question: which of a mixed
-- game's two sides can this player take? Asking for an identity to derive a
-- scheduling fact was both more personal information than the feature needed
-- and a worse fit for it -- there is no third side of a mixed game, so a
-- non-binary player was pushed into 'unspecified' and quietly lost access to
-- balanced seats. A division is something a player states in tennis terms and
-- can answer directly, and it stops the app storing gender at all.
--
-- 'unspecified' survives and keeps its exact meaning: it only ever narrows.
-- Such a player still plays singles and ordinary doubles, and can still take a
-- mixed seat that isn't held to a side.

ALTER TABLE `users` ADD `division` text DEFAULT 'unspecified' NOT NULL;--> statement-breakpoint
ALTER TABLE `game_slots` ADD `seeker_division` text;--> statement-breakpoint

-- Backfill from the columns this replaces (dropped below, so still readable).
--
-- Deliberately conservative, for the same reason 0003 refused to infer
-- 'mixed_singles': matching here is opt-in, and a division a player never
-- actually chose would start offering them seats they never agreed to.
--
--   woman -> womens, man -> mens        the player said which side they play
--   nonbinary, unspecified -> unspecified
--
-- Mapping 'nonbinary' to 'unspecified' loses nothing that was there. Those
-- players could not fill a balanced mixed seat before this migration either,
-- so their access is unchanged -- the difference is that they can now opt into
-- a division themselves rather than being excluded by a category the format
-- doesn't have.
UPDATE `users` SET `division` =
  CASE `gender`
    WHEN 'woman' THEN 'womens'
    WHEN 'man' THEN 'mens'
    ELSE 'unspecified'
  END;--> statement-breakpoint

-- Seats already posted keep the side they were held for, so games mid-fill
-- carry on matching the same players.
UPDATE `game_slots` SET `seeker_division` =
  CASE `seeker_gender`
    WHEN 'woman' THEN 'womens'
    WHEN 'man' THEN 'mens'
    ELSE NULL
  END;--> statement-breakpoint

ALTER TABLE `users` DROP COLUMN `gender`;--> statement-breakpoint
ALTER TABLE `game_slots` DROP COLUMN `seeker_gender`;
