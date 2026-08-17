-- Clears EVERYTHING, courts and locations included, so `seed.sql` can rebuild
-- the facility list from scratch.
--
-- This is the one that changes seeded courts. `reset.sql` deliberately keeps
-- them -- it exists to give development a clean slate of players and games
-- without re-seeding. Use this one when seed.sql itself has changed, because
-- seed.sql is INSERT OR IGNORE on stable ids and will neither update a row
-- that already exists nor remove one that has been dropped from the file.
--
-- Order matters: `games.court_id` is ON DELETE RESTRICT, so every game has to
-- go before any court can. The rest would cascade, but they are listed
-- explicitly so this file doesn't depend on how FK enforcement is configured.
--
-- Destructive. Against production this deletes real games and real players.

DELETE FROM notifications;
DELETE FROM court_slot_locks;
DELETE FROM player_slot_locks;
DELETE FROM game_court_options;
DELETE FROM game_slots;
DELETE FROM games;
DELETE FROM availability_blocks;
DELETE FROM availability_rules;
DELETE FROM user_locations;
DELETE FROM sessions;
DELETE FROM magic_tokens;
DELETE FROM users;
DELETE FROM courts;
DELETE FROM locations;
