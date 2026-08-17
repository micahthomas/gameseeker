-- Santa Fe tennis facilities: public city park courts.
--
-- Scope is deliberately public parks only. Every court in here is one a player
-- can turn up and play on for free, first come first served, which is the
-- promise the rest of the app makes. School courts (Santa Fe High, Capital
-- High, SFCC, St. John's) are real and are the largest clusters in town, but
-- access is at the school's discretion and not bookable, so posting a game on
-- one would invite players somewhere they may not get in. Private clubs
-- (El Gancho, Las Campanas, Santa Fe Tennis & Swim, Quail Run) are excluded
-- for the same reason: members and guests only.
--
-- Deliberately absent, and worth knowing so nobody "fixes" it:
--
--   Shellaberger Tennis Center -- permanently closed since 5 June 2022, the
--     site sold for redevelopment. It still appears in most tennis directories,
--     which is where a lot of bad Santa Fe court data comes from.
--   Genoveva Chavez Community Center -- racquetball courts, not tennis.
--   Fort Marcy / Mager's Field -- its two tennis courts were converted to
--     pickleball. Some directories still list it as tennis.
--   Gen. Franklin E. Miles Park -- ball fields, a skate park and playgrounds,
--     no tennis. The city's own inventory leaves its tennis column blank and
--     the aerial imagery agrees.
--
-- Court counts were checked one park at a time against Esri World Imagery
-- aerials, so they are counted courts rather than reported ones. Three sources
-- disagreed and the imagery settled it:
--
--   * The city's 2014 Parks Division inventory has Salvador Perez and
--     Larragoite transposed (it says 2 and 4; they are 4 and 2).
--   * OpenStreetMap over-counts Atalaya at 4. There are 2.
--   * Third-party tennis directories are unreliable for Santa Fe generally --
--     wrong addresses, rows offset by one -- so don't reconcile against them.
--
-- Addresses are the city's, with one known conflict: the parks locator gives
-- Alto Park as 1121 Alto St while the 2014 inventory says 1043. 1121 is used
-- here as the more current of the two.
--
-- Lat/lng point at the **courts**, not at the park centroid, and each was
-- confirmed by rendering it over the aerial before it went in here. These are
-- big parks -- Salvador Perez is 16 acres, Alto 16 -- so a centroid pin lands
-- someone at the football field or the ball diamonds and leaves them looking
-- for the tennis. Geocoding the street address is worse still: Google resolves
-- Herb Martinez to 914 Camino Carlos Rey rather than the city's 2240, which
-- puts the marker in the wrong part of the park. If you add a map view, these
-- are already the coordinates a player wants to be walking towards.
--
-- Safe to re-run: every insert is INSERT OR IGNORE on a stable id. It will not
-- update or remove a row that already exists -- use `npm run db:rebuild:local`
-- (or :remote) when this file itself has changed.

INSERT OR IGNORE INTO locations (id, name, address, lat, lng, kind, notes, is_active, created_at) VALUES
  ('loc-alto', 'Bicentennial / Alto Park', '1121 Alto St, Santa Fe, NM 87501', 35.685785, -105.963817, 'public_park', 'City park courts, unlighted, first come first served. Close to downtown.', 1, 1755000000000),
  ('loc-salvador-perez', 'Salvador Perez Park', '601 Alta Vista St, Santa Fe, NM 87505', 35.670936, -105.953022, 'public_park', 'City park courts, unlighted, first come first served. Adjacent to the pool and rec center.', 1, 1755000000000),
  ('loc-herb-martinez', 'Herb Martinez / La Resolana Park', '2240 Camino Carlos Rey, Santa Fe, NM 87507', 35.648162, -105.985562, 'public_park', 'City park courts, unlighted, first come first served. Recently resurfaced.', 1, 1755000000000),
  ('loc-larragoite', 'Larragoite Park', 'Agua Fria St & Avenida Cristóbal Colón, Santa Fe, NM 87505', 35.676942, -105.966582, 'public_park', 'City park courts, unlighted, first come first served.', 1, 1755000000000),
  ('loc-atalaya', 'Atalaya Park', '717 Camino Cabra, Santa Fe, NM 87505', 35.672686, -105.911805, 'public_park', 'City park courts by Atalaya Elementary, unlighted, first come first served.', 1, 1755000000000);

-- 17 public park courts: 5 + 4 + 4 + 2 + 2.
-- City park courts are hard surface and none of them are lit.
INSERT OR IGNORE INTO courts (id, location_id, name, surface, has_lights, is_active, sort_order) VALUES
  ('crt-alto-1', 'loc-alto', 'Court 1', 'hard', 0, 1, 1),
  ('crt-alto-2', 'loc-alto', 'Court 2', 'hard', 0, 1, 2),
  ('crt-alto-3', 'loc-alto', 'Court 3', 'hard', 0, 1, 3),
  ('crt-alto-4', 'loc-alto', 'Court 4', 'hard', 0, 1, 4),
  ('crt-alto-5', 'loc-alto', 'Court 5', 'hard', 0, 1, 5),

  ('crt-sp-1', 'loc-salvador-perez', 'Court 1', 'hard', 0, 1, 1),
  ('crt-sp-2', 'loc-salvador-perez', 'Court 2', 'hard', 0, 1, 2),
  ('crt-sp-3', 'loc-salvador-perez', 'Court 3', 'hard', 0, 1, 3),
  ('crt-sp-4', 'loc-salvador-perez', 'Court 4', 'hard', 0, 1, 4),

  ('crt-hm-1', 'loc-herb-martinez', 'Court 1', 'hard', 0, 1, 1),
  ('crt-hm-2', 'loc-herb-martinez', 'Court 2', 'hard', 0, 1, 2),
  ('crt-hm-3', 'loc-herb-martinez', 'Court 3', 'hard', 0, 1, 3),
  ('crt-hm-4', 'loc-herb-martinez', 'Court 4', 'hard', 0, 1, 4),

  ('crt-lg-1', 'loc-larragoite', 'Court 1', 'hard', 0, 1, 1),
  ('crt-lg-2', 'loc-larragoite', 'Court 2', 'hard', 0, 1, 2),

  ('crt-at-1', 'loc-atalaya', 'Court 1', 'hard', 0, 1, 1),
  ('crt-at-2', 'loc-atalaya', 'Court 2', 'hard', 0, 1, 2);
