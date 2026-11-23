-- People Bingo upgrade: 4x4 cards, persistent participant sessions,
-- realtime organiser updates, and concurrency-safe room capacity.
-- Run once in Supabase SQL Editor on your EXISTING project.

begin;

-- Existing 5x5 room prompt banks are reduced to 16 prompts for the new 4x4 card.
-- Review/edit the prompts in the organiser dashboard after this migration.
update public.bingo_rooms
set prompts = prompts[1:16]
where coalesce(array_length(prompts, 1), 0) > 16;

do $$
declare bad_room text;
begin
  select room_code into bad_room
  from public.bingo_rooms
  where coalesce(array_length(prompts, 1), 0) <> 16
  limit 1;
  if bad_room is not null then
    raise exception 'Room % does not have exactly 16 prompts. Update its prompt array to 16 entries, then rerun this migration.', bad_room;
  end if;
end $$;

-- Do not silently truncate cards belonging to people who already joined with a
-- 5x5 layout. Clear test registrations first, or export them and plan a separate
-- conversion before applying this migration.
do $$
begin
  if exists (
    select 1 from public.bingo_participants
    where jsonb_typeof(card) <> 'array' or jsonb_array_length(card) <> 16
  ) then
    raise exception 'Existing participant cards are not 4x4. Remove/export old test participants before upgrading, then rerun this migration.';
  end if;
end $$;

create index if not exists bingo_participants_room_idx
  on public.bingo_participants(room_id);
create index if not exists bingo_participants_room_name_idx
  on public.bingo_participants(room_id, lower(participant_name));
create index if not exists bingo_submissions_room_idx
  on public.bingo_submissions(room_id);

-- A room-row lock serializes all joins to that room. The capacity count therefore
-- sees the previous transaction's committed registration before admitting the next.
create or replace function public.join_bingo_room(
  p_room_code text,
  p_participant_name text,
  p_session_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.bingo_rooms%rowtype;
  p_id uuid;
  c jsonb;
  shuffled text[];
  current_count integer;
  clean_name text := trim(p_participant_name);
begin
  select * into r
  from public.bingo_rooms
  where room_code = upper(trim(p_room_code))
  for update;

  if not found then raise exception 'Room code not found.'; end if;
  if r.status <> 'open' then raise exception 'This room is not currently accepting participants.'; end if;
  if r.capacity < 1 or r.capacity > 200 then raise exception 'Room capacity is not configured correctly.'; end if;
  if clean_name is null or length(clean_name) not between 1 and 60 then raise exception 'Enter a name between 1 and 60 characters.'; end if;
  if coalesce(array_length(r.prompts, 1), 0) <> 16 then raise exception 'This room is not configured with 16 Bingo statements. Contact the organiser.'; end if;

  select count(*) into current_count
  from public.bingo_participants
  where room_id = r.id;
  if current_count >= r.capacity then
    raise exception 'This room has reached its participant limit.';
  end if;

  if exists (
    select 1 from public.bingo_participants
    where room_id = r.id and lower(participant_name) = lower(clean_name)
  ) then
    raise exception 'That name is already registered. Please add an initial or another identifier.';
  end if;

  select array_agg(prompt order by random()) into shuffled
  from unnest(r.prompts) as prompt;

  select jsonb_agg(
    jsonb_build_object('prompt', shuffled[n + 1], 'free', false, 'name', null)
    order by n
  ) into c
  from generate_series(0, 15) as n;

  insert into public.bingo_participants(room_id, session_token, participant_name, card)
  values (r.id, p_session_token, clean_name, c)
  returning id into p_id;

  return jsonb_build_object(
    'participant_id', p_id,
    'participant_name', clean_name,
    'room_id', r.id,
    'room_name', r.room_name,
    'card', c
  );
end;
$$;

create or replace function public.get_my_bingo_participant(
  p_session_token uuid,
  p_room_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.bingo_participants%rowtype;
  r public.bingo_rooms%rowtype;
begin
  select bp.* into p
  from public.bingo_participants bp
  join public.bingo_rooms br on br.id = bp.room_id
  where bp.session_token = p_session_token
    and br.room_code = upper(trim(p_room_code));
  if not found then raise exception 'Saved participant session was not found.'; end if;

  select * into r from public.bingo_rooms where id = p.room_id;
  return jsonb_build_object(
    'participant_id', p.id,
    'participant_name', p.participant_name,
    'room_id', r.id,
    'room_name', r.room_name,
    'card', p.card
  );
end;
$$;

create or replace function public.set_bingo_square(
  p_session_token uuid,
  p_square_index integer,
  p_colleague_name text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.bingo_participants%rowtype;
  c jsonb;
  clean_colleague text := trim(p_colleague_name);
begin
  if p_square_index < 0 or p_square_index > 15 then raise exception 'Invalid Bingo square.'; end if;
  if clean_colleague is null or length(clean_colleague) not between 1 and 60 then raise exception 'Enter a colleague name.'; end if;

  select * into p
  from public.bingo_participants
  where session_token = p_session_token
  for update;
  if not found then raise exception 'Participant session not found. Please rejoin.'; end if;
  if lower(clean_colleague) = lower(p.participant_name) then raise exception 'You cannot enter your own name.'; end if;
  if exists (
    select 1
    from jsonb_array_elements(p.card) with ordinality as x(value, ordinality)
    where (x.ordinality - 1) <> p_square_index
      and lower(coalesce(x.value->>'name', '')) = lower(clean_colleague)
  ) then
    raise exception 'Use a different colleague for each square.';
  end if;

  select jsonb_agg(
    case when ordinality = p_square_index + 1
      then jsonb_set(value, '{name}', to_jsonb(clean_colleague), true)
      else value
    end order by ordinality
  ) into c
  from jsonb_array_elements(p.card) with ordinality;

  update public.bingo_participants set card = c where id = p.id;
  return true;
end;
$$;

create or replace function public.submit_bingo_card(p_session_token uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.bingo_participants%rowtype;
  marked boolean[];
  has_line boolean := false;
  i integer;
  submission_id uuid;
begin
  select * into p
  from public.bingo_participants
  where session_token = p_session_token
  for update;
  if not found then raise exception 'Participant session not found.'; end if;

  select array_agg(coalesce(x->>'name', '') <> '' order by n)
  into marked
  from jsonb_array_elements(p.card) with ordinality as t(x, n);

  for i in 0..3 loop
    if marked[i*4+1] and marked[i*4+2] and marked[i*4+3] and marked[i*4+4] then has_line := true; end if;
    if marked[i+1] and marked[i+5] and marked[i+9] and marked[i+13] then has_line := true; end if;
  end loop;
  if (marked[1] and marked[6] and marked[11] and marked[16])
     or (marked[4] and marked[7] and marked[10] and marked[13]) then
    has_line := true;
  end if;
  if not has_line then raise exception 'Complete a four-square horizontal, vertical or diagonal line before submitting.'; end if;

  -- Prevent duplicate pending submissions from repeated/double taps.
  perform pg_advisory_xact_lock(hashtextextended(p.id::text, 0));
  select id into submission_id
  from public.bingo_submissions
  where participant_id = p.id and status = 'pending'
  order by submitted_at desc
  limit 1;
  if submission_id is not null then return submission_id; end if;

  insert into public.bingo_submissions(participant_id, room_id)
  values (p.id, p.room_id)
  returning id into submission_id;
  return submission_id;
end;
$$;

create or replace function public.get_bingo_admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.bingo_rooms%rowtype;
  participants jsonb;
  submissions jsonb;
  pc integer;
  sc integer;
  wc integer;
begin
  select * into r
  from public.bingo_rooms
  where organiser_id = auth.uid()
  order by created_at desc
  limit 1;
  if not found then raise exception 'No room found for this organiser.'; end if;

  select count(*) into pc from public.bingo_participants where room_id = r.id;
  select count(*) into sc from public.bingo_submissions where room_id = r.id;
  select count(*) into wc from public.bingo_submissions where room_id = r.id and status = 'approved';

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'name', p.participant_name,
      'joined_at', p.joined_at,
      'completed_count', (select count(*) from jsonb_array_elements(p.card) x where coalesce(x->>'name', '') <> '')
    ) order by p.joined_at desc
  ), '[]'::jsonb)
  into participants
  from public.bingo_participants p
  where p.room_id = r.id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', s.id,
      'participant_name', p.participant_name,
      'submitted_at', s.submitted_at,
      'status', s.status
    ) order by s.submitted_at desc
  ), '[]'::jsonb)
  into submissions
  from public.bingo_submissions s
  join public.bingo_participants p on p.id = s.participant_id
  where s.room_id = r.id;

  return jsonb_build_object(
    'participant_count', pc,
    'submission_count', sc,
    'winner_count', wc,
    'participants', participants,
    'submissions', submissions
  );
end;
$$;

create or replace function public.update_bingo_room(
  p_room_name text,
  p_capacity integer,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.bingo_rooms%rowtype;
  participant_count integer;
begin
  if p_capacity not between 1 and 200 then raise exception 'Capacity must be between 1 and 200.'; end if;
  if p_status not in ('open', 'paused', 'closed') then raise exception 'Invalid room status.'; end if;

  select * into r from public.bingo_rooms where organiser_id = auth.uid() order by created_at desc limit 1 for update;
  if not found then raise exception 'No room found for this organiser.'; end if;
  select count(*) into participant_count from public.bingo_participants where room_id = r.id;
  if p_capacity < participant_count then raise exception 'Capacity cannot be lower than the number of participants already registered.'; end if;

  update public.bingo_rooms
  set room_name = left(trim(p_room_name), 80), capacity = p_capacity, status = p_status
  where id = r.id;
  return true;
end;
$$;

create or replace function public.update_bingo_prompts(p_prompts text[])
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(array_length(p_prompts, 1), 0) <> 16 then raise exception 'Exactly 16 prompts are required for a 4x4 card.'; end if;
  if exists(select 1 from unnest(p_prompts) x where x is null or length(trim(x)) = 0 or length(x) > 100) then
    raise exception 'Each prompt must contain 1 to 100 characters.';
  end if;
  update public.bingo_rooms
  set prompts = p_prompts
  where organiser_id = auth.uid();
  if not found then raise exception 'No room found for this organiser.'; end if;
  return true;
end;
$$;

-- Organiser-only SELECT access is needed for Supabase Postgres Changes.
-- Anonymous participants continue to access their own card only through token-based RPCs.
drop policy if exists bingo_participants_organiser_select on public.bingo_participants;
create policy bingo_participants_organiser_select
on public.bingo_participants for select to authenticated
using (public.is_bingo_organiser(room_id));

drop policy if exists bingo_submissions_organiser_select on public.bingo_submissions;
create policy bingo_submissions_organiser_select
on public.bingo_submissions for select to authenticated
using (public.is_bingo_organiser(room_id));

grant select on public.bingo_participants, public.bingo_submissions to authenticated;

-- Ensure both tables are part of Supabase Realtime publication, without failing if already added.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bingo_participants'
    ) then
      execute 'alter publication supabase_realtime add table public.bingo_participants';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bingo_submissions'
    ) then
      execute 'alter publication supabase_realtime add table public.bingo_submissions';
    end if;
  else
    raise notice 'supabase_realtime publication not found; enable Realtime for bingo_participants and bingo_submissions in the Supabase dashboard.';
  end if;
end;
$$;

-- Refresh function grants after CREATE OR REPLACE.
revoke all on function public.join_bingo_room(text, text, uuid) from public;
revoke all on function public.get_my_bingo_participant(uuid, text) from public;
revoke all on function public.set_bingo_square(uuid, integer, text) from public;
revoke all on function public.submit_bingo_card(uuid) from public;
revoke all on function public.get_bingo_admin_overview() from public;
revoke all on function public.update_bingo_room(text, integer, text) from public;
revoke all on function public.update_bingo_prompts(text[]) from public;

grant execute on function public.join_bingo_room(text, text, uuid) to anon, authenticated;
grant execute on function public.get_my_bingo_participant(uuid, text) to anon, authenticated;
grant execute on function public.set_bingo_square(uuid, integer, text) to anon, authenticated;
grant execute on function public.submit_bingo_card(uuid) to anon, authenticated;
grant execute on function public.get_bingo_admin_overview() to authenticated;
grant execute on function public.update_bingo_room(text, integer, text) to authenticated;
grant execute on function public.update_bingo_prompts(text[]) to authenticated;

commit;
