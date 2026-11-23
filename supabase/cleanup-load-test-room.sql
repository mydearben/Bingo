-- Run only after the load test. This removes the disposable room and its
-- synthetic participants/submissions through the configured ON DELETE CASCADE.
-- If you changed LOAD26 in create-load-test-room.sql, change it here too.
delete from public.bingo_rooms where room_code = 'LOAD26';
