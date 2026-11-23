-- Create an EMPTY, disposable room for the 150–200 participant load test.
-- Replace the organiser UUID. Change LOAD26 if that six-character room code is already in use.
-- After the test, run cleanup-load-test-room.sql to remove all synthetic data.

insert into public.bingo_rooms (room_code, room_name, capacity, status, organiser_id, prompts)
values (
  'LOAD26',
  'Temporary People Bingo Load Test',
  200,
  'open',
  'REPLACE-WITH-ORGANISER-AUTH-UUID'::uuid,
  array[
    'Has a pet',
    'Speaks more than two languages',
    'Has visited Japan',
    'Enjoys hiking',
    'Plays a musical instrument',
    'Loves coffee',
    'Has worked here for over five years',
    'Can cook a signature dish',
    'Has run a race',
    'Enjoys photography',
    'Is an early bird',
    'Has siblings',
    'Has lived overseas',
    'Enjoys board games',
    'Can speak three languages',
    'Has a hidden talent'
  ]
);
