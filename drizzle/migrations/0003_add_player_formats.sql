ALTER TABLE `users` ADD `formats` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
-- Backfill from the three booleans this replaces (dropped in 0004, so they are
-- still readable here).
--
-- Deliberately conservative: `plays_mixed` only ever meant mixed *doubles* —
-- `games.is_mixed` was only valid for doubles — so nobody is opted into
-- 'mixed_singles' by this migration. Matching in this app is opt-in, and
-- inferring a format a player never actually agreed to would start sending
-- them games they never asked for. Mixed singles is new; players pick it
-- themselves in the profile form.
UPDATE `users` SET `formats` =
  '[' ||
  TRIM(
    (CASE WHEN `plays_singles` = 1 THEN '"singles",' ELSE '' END) ||
    (CASE WHEN `plays_doubles` = 1 THEN '"doubles",' ELSE '' END) ||
    (CASE WHEN `plays_doubles` = 1 AND `plays_mixed` = 1 THEN '"mixed_doubles",' ELSE '' END),
    ','
  ) ||
  ']'
WHERE `formats` = '[]';--> statement-breakpoint
-- A player who had every box unticked would otherwise end up with an empty set
-- and silently stop matching anything at all. Singles is the smallest honest
-- default, and it is what the old `plays_singles` column defaulted to.
UPDATE `users` SET `formats` = '["singles"]' WHERE `formats` = '[]';
