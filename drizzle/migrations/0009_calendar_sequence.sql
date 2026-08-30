-- The iCalendar SEQUENCE for the invite a game sends out.
--
-- A calendar client ignores an update whose sequence hasn't advanced, so
-- without this a cancellation would leave the entry sitting on every player's
-- calendar. Bumped when a game is called off, and by anything that moves it.
--
-- Additive: the deployed Worker neither reads nor writes this column until the
-- release that introduces it, so the migrate-then-deploy window is safe.
ALTER TABLE `games` ADD `calendar_seq` integer DEFAULT 0 NOT NULL;
