-- Clears all player and game data while keeping the seeded courts.
--
-- Useful when you want a clean slate in local development, and used by
-- `npm run smoke` so the end-to-end run starts from a known state.
--
-- Never run this against production.

DELETE FROM notifications;
DELETE FROM court_slot_locks;
DELETE FROM game_slots;
DELETE FROM games;
DELETE FROM availability_blocks;
DELETE FROM availability_rules;
DELETE FROM sessions;
DELETE FROM magic_tokens;
DELETE FROM users;
