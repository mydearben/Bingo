-- People Bingo schema for Supabase
-- Run in Supabase SQL Editor after creating an organiser user in Authentication.
-- Replace the room seed values below with your event name and desired six-character code.

create extension if not exists pgcrypto;

create table if not exists public.bingo_rooms (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique check (room_code ~ '^[A-Z0-9]{6}$'),
  room_name text not null default 'Company Networking Bingo',
  capacity integer not null default 200 check (capacity between 1 and 200),
  status text not null default 'open' check (status in ('open','paused','closed')),
  organiser_id uuid not null references auth.users(id) on delete cascade,
  prompts text[] not null,
  created_at timestamptz not null default now()
);

create table if not exists public.bingo_participants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.bingo_rooms(id) on delete cascade,
  session_token uuid not null unique,
  participant_name text not null check (length(trim(participant_name)) between 1 and 60),
  card jsonb not null,
  joined_at timestamptz not null default now()
);

create table if not exists public.bingo_submissions (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.bingo_participants(id) on delete cascade,
  room_id uuid not null references public.bingo_rooms(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id)
);

create index if not exists bingo_participants_room_idx on public.bingo_participants(room_id);
create index if not exists bingo_submissions_room_idx on public.bingo_submissions(room_id);

alter table public.bingo_rooms enable row level security;
alter table public.bingo_participants enable row level security;
alter table public.bingo_submissions enable row level security;

-- Browser clients cannot directly read/write tables. Access is through constrained RPCs.
revoke all on public.bingo_rooms, public.bingo_participants, public.bingo_submissions from anon, authenticated;
grant select, insert, update, delete on public.bingo_rooms, public.bingo_participants, public.bingo_submissions to service_role;

create or replace function public.is_bingo_organiser(p_room_id uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.bingo_rooms where id=p_room_id and organiser_id=auth.uid()) $$;

create or replace function public.join_bingo_room(p_room_code text,p_participant_name text,p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.bingo_rooms%rowtype; p_id uuid; c jsonb; shuffled text[];
begin
  select * into r from public.bingo_rooms where room_code=upper(trim(p_room_code));
  if not found then raise exception 'Room code not found.'; end if;
  if r.status <> 'open' then raise exception 'This room is not currently accepting participants.'; end if;
  if (select count(*) from public.bingo_participants where room_id=r.id) >= r.capacity then raise exception 'This room has reached its participant limit.'; end if;
  if length(trim(p_participant_name)) not between 1 and 60 then raise exception 'Enter a name between 1 and 60 characters.'; end if;
  if exists(select 1 from public.bingo_participants where room_id=r.id and lower(participant_name)=lower(trim(p_participant_name))) then
    raise exception 'That name is already registered. Please add an initial or another identifier.';
  end if;
  select array_agg(x order by random()) into shuffled from unnest(r.prompts) x;
  select jsonb_agg(case when n=13 then jsonb_build_object('prompt','FREE SPACE','free',true,'name',null) else jsonb_build_object('prompt',shuffled[n + case when n>13 then -1 else 0 end],'free',false,'name',null) end order by n)
  into c from generate_series(1,25) n;
  insert into public.bingo_participants(room_id,session_token,participant_name,card)
  values(r.id,p_session_token,trim(p_participant_name),c) returning id into p_id;
  return jsonb_build_object('participant_id',p_id,'participant_name',trim(p_participant_name),'room_id',r.id,'room_name',r.room_name,'card',c);
end $$;

create or replace function public.set_bingo_square(p_session_token uuid,p_square_index integer,p_colleague_name text)
returns boolean language plpgsql security definer set search_path=public
as $$
declare p public.bingo_participants%rowtype; c jsonb; item jsonb;
begin
  if p_square_index < 0 or p_square_index > 24 or p_square_index=12 then raise exception 'Invalid Bingo square.'; end if;
  if length(trim(p_colleague_name)) not between 1 and 60 then raise exception 'Enter a colleague name.'; end if;
  select * into p from public.bingo_participants where session_token=p_session_token for update;
  if not found then raise exception 'Participant session not found. Please rejoin.'; end if;
  if lower(trim(p_colleague_name))=lower(p.participant_name) then raise exception 'You cannot enter your own name.'; end if;
  if exists(select 1 from jsonb_array_elements(p.card) with ordinality x(v,n) where (n-1)<>p_square_index and lower(coalesce(x.v->>'name',''))=lower(trim(p_colleague_name))) then
    raise exception 'Use a different colleague for each square.';
  end if;
  select jsonb_agg(case when ordinality=p_square_index+1 then jsonb_set(value,'{name}',to_jsonb(trim(p_colleague_name)),true) else value end order by ordinality)
  into c from jsonb_array_elements(p.card) with ordinality;
  update public.bingo_participants set card=c where id=p.id;
  return true;
end $$;

create or replace function public.submit_bingo_card(p_session_token uuid)
returns uuid language plpgsql security definer set search_path=public
as $$
declare p public.bingo_participants%rowtype; marked boolean[]; has_line boolean:=false; submission_id uuid;
begin
  select * into p from public.bingo_participants where session_token=p_session_token;
  if not found then raise exception 'Participant session not found.'; end if;
  select array_agg((coalesce(x->>'free','false')='true' or coalesce(x->>'name','')<>'') order by n)
    into marked from jsonb_array_elements(p.card) with ordinality t(x,n);
  for i in 0..4 loop
    if (marked[i*5+1] and marked[i*5+2] and marked[i*5+3] and marked[i*5+4] and marked[i*5+5])
      or (marked[i+1] and marked[i+6] and marked[i+11] and marked[i+16] and marked[i+21]) then has_line:=true; end if;
  end loop;
  if (marked[1] and marked[7] and marked[13] and marked[19] and marked[25]) or
     (marked[5] and marked[9] and marked[13] and marked[17] and marked[21]) then has_line:=true; end if;
  if not has_line then raise exception 'Complete a horizontal, vertical or diagonal line before submitting.'; end if;
  insert into public.bingo_submissions(participant_id,room_id)
  values(p.id,p.room_id) returning id into submission_id;
  return submission_id;
end $$;

create or replace function public.get_my_bingo_room()
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.bingo_rooms%rowtype;
begin
  select * into r from public.bingo_rooms where organiser_id=auth.uid() order by created_at desc limit 1;
  if not found then raise exception 'No Bingo room is assigned to this organiser. Ask the database administrator to create one.'; end if;
  return jsonb_build_object('id',r.id,'room_code',r.room_code,'room_name',r.room_name,'capacity',r.capacity,'status',r.status,'prompts',to_jsonb(r.prompts));
end $$;

create or replace function public.get_bingo_admin_overview()
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.bingo_rooms%rowtype; participants jsonb; submissions jsonb; pc integer; sc integer; wc integer;
begin
  select * into r from public.bingo_rooms where organiser_id=auth.uid() order by created_at desc limit 1;
  if not found then raise exception 'No room found for this organiser.'; end if;
  select count(*) into pc from public.bingo_participants where room_id=r.id;
  select count(*) into sc from public.bingo_submissions where room_id=r.id;
  select count(*) into wc from public.bingo_submissions where room_id=r.id and status='approved';
  select coalesce(jsonb_agg(jsonb_build_object('name',p.participant_name,'joined_at',p.joined_at,'completed_count',(select count(*) from jsonb_array_elements(p.card) x where coalesce(x->>'free','false')='false' and coalesce(x->>'name','')<>'')) order by p.joined_at desc),'[]'::jsonb)
  into participants from public.bingo_participants p where p.room_id=r.id;
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'participant_name',p.participant_name,'submitted_at',s.submitted_at,'status',s.status) order by s.submitted_at desc),'[]'::jsonb)
  into submissions from public.bingo_submissions s join public.bingo_participants p on p.id=s.participant_id where s.room_id=r.id;
  return jsonb_build_object('participant_count',pc,'submission_count',sc,'winner_count',wc,'participants',participants,'submissions',submissions);
end $$;

create or replace function public.update_bingo_room(p_room_name text,p_capacity integer,p_status text)
returns boolean language plpgsql security definer set search_path=public
as $$
begin
  if p_capacity not between 1 and 200 then raise exception 'Capacity must be between 1 and 200.'; end if;
  if p_status not in ('open','paused','closed') then raise exception 'Invalid room status.'; end if;
  update public.bingo_rooms set room_name=left(trim(p_room_name),80),capacity=p_capacity,status=p_status where organiser_id=auth.uid();
  if not found then raise exception 'No room found for this organiser.'; end if;
  return true;
end $$;

create or replace function public.update_bingo_prompts(p_prompts text[])
returns boolean language plpgsql security definer set search_path=public
as $$
begin
  if coalesce(array_length(p_prompts,1),0)<>24 then raise exception 'Exactly 24 prompts are required.'; end if;
  if exists(select 1 from unnest(p_prompts) x where length(trim(x))=0 or length(x)>100) then raise exception 'Each prompt must contain 1 to 100 characters.'; end if;
  update public.bingo_rooms set prompts=p_prompts where organiser_id=auth.uid();
  if not found then raise exception 'No room found for this organiser.'; end if;
  return true;
end $$;

create or replace function public.review_bingo_submission(p_submission_id uuid,p_decision text)
returns boolean language plpgsql security definer set search_path=public
as $$
begin
  if p_decision not in ('approved','rejected') then raise exception 'Invalid review decision.'; end if;
  update public.bingo_submissions s set status=p_decision,reviewed_at=now(),reviewed_by=auth.uid()
  from public.bingo_rooms r where s.id=p_submission_id and s.room_id=r.id and r.organiser_id=auth.uid();
  if not found then raise exception 'Submission not found or not authorised.'; end if;
  return true;
end $$;

revoke all on function public.join_bingo_room(text,text,uuid) from public;
revoke all on function public.set_bingo_square(uuid,integer,text) from public;
revoke all on function public.submit_bingo_card(uuid) from public;
revoke all on function public.get_my_bingo_room() from public;
revoke all on function public.get_bingo_admin_overview() from public;
revoke all on function public.update_bingo_room(text,integer,text) from public;
revoke all on function public.update_bingo_prompts(text[]) from public;
revoke all on function public.review_bingo_submission(uuid,text) from public;
grant execute on function public.join_bingo_room(text,text,uuid) to anon, authenticated;
grant execute on function public.set_bingo_square(uuid,integer,text) to anon, authenticated;
grant execute on function public.submit_bingo_card(uuid) to anon, authenticated;
grant execute on function public.get_my_bingo_room() to authenticated;
grant execute on function public.get_bingo_admin_overview() to authenticated;
grant execute on function public.update_bingo_room(text,integer,text) to authenticated;
grant execute on function public.update_bingo_prompts(text[]) to authenticated;
grant execute on function public.review_bingo_submission(uuid,text) to authenticated;

-- Create an organiser login in Supabase Authentication > Users, then run this seed.
-- Replace the UUID with that user's Auth UID. Choose your own unique 6-character room code.
-- insert into public.bingo_rooms(room_code,room_name,capacity,status,organiser_id,prompts)
-- values ('TEAM26','Company Networking Bingo',200,'open','YOUR-AUTH-USER-UUID',
-- array[
-- 'Has a pet','Speaks more than two languages','Has visited Japan','Enjoys hiking',
-- 'Plays a musical instrument','Loves coffee','Has worked here for over five years',
-- 'Can cook a signature dish','Has run a race','Enjoys photography','Is an early bird',
-- 'Has siblings','Has lived overseas','Enjoys board games','Can speak three languages',
-- 'Has a hidden talent','Loves travelling','Is a sports fan','Enjoys reading',
-- 'Has tried an unusual food','Can recommend a good book','Has a birthday this month',
-- 'Has learned a new skill recently','Enjoys volunteering'
-- ]);
