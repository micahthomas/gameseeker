-- Santa Fe tennis facilities.
--
-- Court counts total 19 across the five city parks, matching public reporting
-- on the city's tennis inventory. Addresses and per-court counts are
-- best-effort starting points -- verify them against reality and edit at
-- /admin/locations. Lat/lng are intentionally NULL rather than approximated;
-- fill them in from a map when you want pin locations.
--
-- Fort Marcy is deliberately absent: its two tennis courts were converted to
-- pickleball courts.
--
-- Safe to re-run: every insert is INSERT OR IGNORE on a stable id.

INSERT OR IGNORE INTO locations (id, name, address, lat, lng, kind, notes, is_active, created_at) VALUES
  ('loc-salvador-perez', 'Salvador Perez Park', '601 Alta Vista St, Santa Fe, NM 87505', NULL, NULL, 'public_park', 'City park courts, first come first served. Adjacent to the pool and rec center.', 1, 1755000000000),
  ('loc-herb-martinez', 'Herb Martinez / La Resolana Park', '2240 Camino Carlos Rey, Santa Fe, NM 87507', NULL, NULL, 'public_park', 'City park courts, first come first served.', 1, 1755000000000),
  ('loc-alto', 'Ron Shirley / Alto Park', '1121 Alto St, Santa Fe, NM 87501', NULL, NULL, 'public_park', 'City park courts, first come first served. Close to downtown.', 1, 1755000000000),
  ('loc-larragoite', 'Larragoite Park', '1600 Agua Fria St, Santa Fe, NM 87505', NULL, NULL, 'public_park', 'City park courts, first come first served.', 1, 1755000000000),
  ('loc-atalaya', 'Atalaya Park', '1160 Camino Cruz Blanca, Santa Fe, NM 87505', NULL, NULL, 'public_park', 'City park courts by Atalaya Elementary, first come first served.', 1, 1755000000000),
  ('loc-gccc', 'Genoveva Chavez Community Center', '3221 Rodeo Rd, Santa Fe, NM 87507', NULL, NULL, 'rec_center', 'City recreation center. Check facility hours and any drop-in fees before booking here.', 1, 1755000000000),
  ('loc-sf-tennis-swim', 'Santa Fe Tennis & Swim Club', '1755 Camino Corrales, Santa Fe, NM 87505', NULL, NULL, 'club', 'Private club -- members and their guests only.', 1, 1755000000000);

-- 19 public park courts: 6 + 4 + 5 + 2 + 2
INSERT OR IGNORE INTO courts (id, location_id, name, surface, has_lights, is_active, sort_order) VALUES
  ('crt-sp-1', 'loc-salvador-perez', 'Court 1', 'hard', 0, 1, 1),
  ('crt-sp-2', 'loc-salvador-perez', 'Court 2', 'hard', 0, 1, 2),
  ('crt-sp-3', 'loc-salvador-perez', 'Court 3', 'hard', 0, 1, 3),
  ('crt-sp-4', 'loc-salvador-perez', 'Court 4', 'hard', 0, 1, 4),
  ('crt-sp-5', 'loc-salvador-perez', 'Court 5', 'hard', 0, 1, 5),
  ('crt-sp-6', 'loc-salvador-perez', 'Court 6', 'hard', 0, 1, 6),

  ('crt-hm-1', 'loc-herb-martinez', 'Court 1', 'hard', 0, 1, 1),
  ('crt-hm-2', 'loc-herb-martinez', 'Court 2', 'hard', 0, 1, 2),
  ('crt-hm-3', 'loc-herb-martinez', 'Court 3', 'hard', 0, 1, 3),
  ('crt-hm-4', 'loc-herb-martinez', 'Court 4', 'hard', 0, 1, 4),

  ('crt-alto-1', 'loc-alto', 'Court 1', 'hard', 0, 1, 1),
  ('crt-alto-2', 'loc-alto', 'Court 2', 'hard', 0, 1, 2),
  ('crt-alto-3', 'loc-alto', 'Court 3', 'hard', 0, 1, 3),
  ('crt-alto-4', 'loc-alto', 'Court 4', 'hard', 0, 1, 4),
  ('crt-alto-5', 'loc-alto', 'Court 5', 'hard', 0, 1, 5),

  ('crt-lg-1', 'loc-larragoite', 'Court 1', 'hard', 0, 1, 1),
  ('crt-lg-2', 'loc-larragoite', 'Court 2', 'hard', 0, 1, 2),

  ('crt-at-1', 'loc-atalaya', 'Court 1', 'hard', 0, 1, 1),
  ('crt-at-2', 'loc-atalaya', 'Court 2', 'hard', 0, 1, 2),

  ('crt-gccc-1', 'loc-gccc', 'Court 1', 'hard', 0, 1, 1),
  ('crt-gccc-2', 'loc-gccc', 'Court 2', 'hard', 0, 1, 2),

  ('crt-sfts-1', 'loc-sf-tennis-swim', 'Court 1', 'hard', 1, 1, 1),
  ('crt-sfts-2', 'loc-sf-tennis-swim', 'Court 2', 'hard', 1, 1, 2),
  ('crt-sfts-3', 'loc-sf-tennis-swim', 'Court 3', 'hard', 1, 1, 3),
  ('crt-sfts-4', 'loc-sf-tennis-swim', 'Court 4', 'hard', 0, 1, 4);
