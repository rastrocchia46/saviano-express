-- Saviano Express • Eseguire UNA volta su un progetto Supabase nuovo/dedicato.
-- Non inserire codici di accesso in questo file o nel repository GitHub.
create extension if not exists pgcrypto with schema extensions;

create table public.sx_teams (
 id uuid primary key default gen_random_uuid(),
 name text not null unique check (char_length(name) between 2 and 45),
 color text not null default '#DF5A30' check (color ~ '^#[0-9A-Fa-f]{6}$'),
 created_at timestamptz not null default now()
);
create table public.sx_identity (
 id bigint generated always as identity primary key,
 role text not null check (role in ('admin','commissioner','team')),
 team_id uuid references public.sx_teams(id) on delete cascade,
 code_hash text not null unique,
 check ((role='admin' and team_id is null) or (role<>'admin' and team_id is not null))
);
create table public.sx_sessions (
 token_hash text primary key,
 identity_id bigint not null references public.sx_identity(id) on delete cascade,
 expires_at timestamptz not null
);
create table public.sx_stages (
 number int primary key check(number between 1 and 5),
 title text not null,
 clue text not null default '',
 objects jsonb not null default '[]'::jsonb check (jsonb_typeof(objects)='array' and jsonb_array_length(objects) <= 12),
 released boolean not null default false,
 public_override boolean not null default false
);
create table public.sx_progress (
 team_id uuid not null references public.sx_teams(id) on delete cascade,
 stage_number int not null references public.sx_stages(number),
 started_at timestamptz,
 ended_at timestamptz,
 verified boolean not null default false,
 checked jsonb not null default '[]'::jsonb check (jsonb_typeof(checked)='array'),
 requested jsonb not null default '[false,false]'::jsonb,
 hints jsonb not null default '[false,false]'::jsonb,
 final_ready_at timestamptz,
 primary key(team_id,stage_number)
);
create table public.sx_locations (
 team_id uuid primary key references public.sx_teams(id) on delete cascade,
 lat double precision, lng double precision,
 accuracy double precision,
 updated_at timestamptz,
 public_opt_in boolean not null default false
);
insert into public.sx_stages(number,title) values
 (1,'La prima busta'),(2,'La seconda tappa'),(3,'La terza tappa'),(4,'La quarta tappa'),(5,'Il tesoro');

-- Nessun accesso diretto ai dati dal browser: solo funzioni RPC controllate.
revoke all on public.sx_teams, public.sx_identity, public.sx_sessions,
 public.sx_stages, public.sx_progress, public.sx_locations from public, anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter table public.sx_teams enable row level security;
alter table public.sx_identity enable row level security;
alter table public.sx_sessions enable row level security;
alter table public.sx_stages enable row level security;
alter table public.sx_progress enable row level security;
alter table public.sx_locations enable row level security;

create or replace function public.sx_who(p_token text)
returns table(actor_role text, actor_team uuid)
language sql security definer set search_path = '' as $$
 select i.role, i.team_id
 from public.sx_sessions s join public.sx_identity i on i.id=s.identity_id
 where s.token_hash=encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex')
   and s.expires_at > now()
 limit 1
$$;
revoke all on function public.sx_who(text) from public, anon, authenticated;

create or replace function public.sx_login(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.sx_identity%rowtype; tok text;
begin
 if p_code is null or length(p_code) < 16 or length(p_code)>180 then
   raise exception 'Codice non valido';
 end if;
 select * into v from public.sx_identity
 where code_hash=encode(extensions.digest(p_code,'sha256'),'hex') limit 1;
 if v.id is null then raise exception 'Codice non valido'; end if;
 tok=encode(extensions.gen_random_bytes(32),'hex');
 insert into public.sx_sessions(token_hash,identity_id,expires_at)
 values (encode(extensions.digest(tok,'sha256'),'hex'),v.id,now()+interval '10 days');
 return jsonb_build_object('token',tok,'role',v.role,'teamId',v.team_id);
end $$;

create or replace function public.sx_state(p_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r text := 'public'; my_id uuid; t record; st record; p public.sx_progress%rowtype;
 loc public.sx_locations%rowtype; stages_json jsonb:='[]'::jsonb; teams_json jsonb:='[]'::jsonb;
 prs jsonb; per_team jsonb; visible boolean; publish boolean; elapsed bigint; corrected bigint;
 found int; num_objects int; penalty int; latest_stage int; gps_payload jsonb;
begin
 select actor_role,actor_team into r,my_id from public.sx_who(p_token);
 r := coalesce(r,'public');
 for st in select * from public.sx_stages order by number loop
   select coalesce(bool_or(p0.started_at <= now() - interval '30 minutes'),false)
    into publish from public.sx_progress p0 where p0.stage_number=st.number;
   publish := publish or st.public_override;
   visible := (r='admin' or publish or (my_id is not null and exists
     (select 1 from public.sx_progress x where x.team_id=my_id and x.stage_number=st.number and x.started_at is not null)));
   stages_json := stages_json || jsonb_build_array(jsonb_build_object(
     'number',st.number,'title',case when visible then st.title else case when st.number=5 then 'Il tesoro' else 'Indovinello '||st.number end end,
     'clue',case when visible then st.clue else null end,
     'objects',case when visible then st.objects else '[]'::jsonb end,
     'released',st.released,'published',publish,'publicOverride',case when r='admin' then st.public_override else null end,'visible',visible));
 end loop;
 for t in select * from public.sx_teams order by created_at,id loop
   per_team:='[]'::jsonb;
   for st in select * from public.sx_stages order by number loop
     select * into p from public.sx_progress where team_id=t.id and stage_number=st.number;
     num_objects:=jsonb_array_length(st.objects);
     select count(*) into found from jsonb_array_elements_text(p.checked) c(x) where x='true';
     penalty:=(num_objects-2*found)*5 +
       (case when (p.hints->>0)::boolean then 15 else 0 end) +
       (case when (p.hints->>1)::boolean then 20 else 0 end);
     elapsed:=case when p.started_at is not null
       then round(extract(epoch from (coalesce(p.ended_at,clock_timestamp())-p.started_at))*1000)::bigint else null end;
     corrected:=case when p.verified then elapsed+penalty*60000 else null end;
     per_team:=per_team || jsonb_build_array(jsonb_build_object(
       'startedAt',p.started_at,'endedAt',p.ended_at,'verified',p.verified,
       'elapsedMs',elapsed,'correctedMs',corrected,
       'checked',case when r='admin' or (my_id=t.id and r in ('team','commissioner')) then p.checked else null end,
       'requested',case when r='admin' or (my_id=t.id and r in ('team','commissioner')) then p.requested else null end,
       'hints',case when r='admin' or (my_id=t.id and r in ('team','commissioner')) then p.hints else null end,
       'finalReadyAt',case when r='admin' or my_id=t.id then p.final_ready_at else null end
     ));
   end loop;
   select * into loc from public.sx_locations where team_id=t.id;
   select max(stage_number) into latest_stage from public.sx_progress
     where team_id=t.id and started_at is not null and ended_at is null;
   gps_payload:=null;
   if loc.updated_at >= now()-interval '90 seconds' and loc.lat is not null then
     if r='admin' or (r in ('team','commissioner') and my_id=t.id) then
       gps_payload:=jsonb_build_object('lat',loc.lat,'lng',loc.lng,'accuracy',loc.accuracy,'updatedAt',loc.updated_at,'approximate',false);
     elsif loc.public_opt_in and latest_stage is not null and latest_stage<5 and
      exists(select 1 from public.sx_progress px where px.team_id=t.id and px.stage_number=latest_stage
       and px.started_at <= now()-interval '30 minutes') then
       gps_payload:=jsonb_build_object('lat',round(loc.lat::numeric,3),'lng',round(loc.lng::numeric,3),
         'updatedAt',loc.updated_at,'approximate',true);
     end if;
   end if;
   teams_json:=teams_json || jsonb_build_array(jsonb_build_object(
     'id',t.id,'name',t.name,'color',t.color,'stages',per_team,'gps',gps_payload));
 end loop;
 return jsonb_build_object('role',r,'teamId',my_id,'serverNow',clock_timestamp(),
   'stages',stages_json,'teams',teams_json);
end $$;

create or replace function public.sx_action(p_token text,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r text; my_id uuid; target uuid; n int; ix int; pr public.sx_progress%rowtype;
 st public.sx_stages%rowtype; team_name text; team_color text; team_code text; com_code text;
 candidate text; object_count int; f int; shift_ms bigint; first_ms bigint;
 b boolean; v_lat double precision; v_lng double precision; v_acc double precision;
begin
 select actor_role,actor_team into r,my_id from public.sx_who(p_token);
 if r is null then raise exception 'Sessione scaduta: effettua nuovamente l’accesso'; end if;
 if p_action in ('create_team','edit_stage','open_stage','publish_stage','plan_final') and r<>'admin' then
  raise exception 'Azione riservata alla regia';
 end if;
 if p_action='create_team' then
   if exists(select 1 from public.sx_progress where started_at is not null) then
     raise exception 'Non è possibile aggiungere squadre a gara iniziata'; end if;
   team_name:=btrim(p_payload->>'name');team_color:=coalesce(p_payload->>'color','#DF5A30');
   if length(team_name) not between 2 and 45 or team_color !~ '^#[0-9A-Fa-f]{6}$' then
      raise exception 'Nome o colore non validi'; end if;
   insert into public.sx_teams(name,color) values(team_name,team_color) returning id into target;
   insert into public.sx_progress(team_id,stage_number) select target,number from public.sx_stages;
   insert into public.sx_locations(team_id) values(target);
   team_code:=encode(extensions.gen_random_bytes(18),'hex');
   com_code:=encode(extensions.gen_random_bytes(18),'hex');
   insert into public.sx_identity(role,team_id,code_hash)
     values('team',target,encode(extensions.digest(team_code,'sha256'),'hex')),
           ('commissioner',target,encode(extensions.digest(com_code,'sha256'),'hex'));
   return jsonb_build_object('ok',true,'id',target,'teamCode',team_code,'commissionerCode',com_code);
 end if;
 n:=nullif(p_payload->>'stage','')::int;
 if p_action in ('edit_stage','open_stage','publish_stage','start','check','request_hint','grant_hint','verify') and
    (n is null or n not between 1 and 5) then raise exception 'Tappa non valida'; end if;
 if p_action='edit_stage' then
   if exists(select 1 from public.sx_progress where stage_number=n and started_at is not null) then
     raise exception 'Contenuti bloccati: la tappa è già iniziata'; end if;
   candidate:=btrim(coalesce(p_payload->>'clue',''));
   team_name:=btrim(coalesce(p_payload->>'title',''));
   if length(team_name) not between 2 and 90 or length(candidate)>3000 or
     jsonb_typeof(p_payload->'objects') is distinct from 'array' then raise exception 'Contenuti non validi'; end if;
   object_count:=jsonb_array_length(p_payload->'objects');
   if (n=1 and object_count<>12) or (n>1 and object_count not in(0,12)) then
     raise exception 'La prima prova richiede 12 oggetti, le altre zero oppure 12'; end if;
   if exists(select 1 from jsonb_array_elements(p_payload->'objects') o(x)
      where jsonb_typeof(o.x)<>'string' or length(btrim(o.x #>> '{}')) not between 1 and 120) then
      raise exception 'Oggetti non validi'; end if;
   update public.sx_stages set title=team_name,clue=candidate,objects=p_payload->'objects' where number=n;
   return jsonb_build_object('ok',true);
 end if;
 if p_action='open_stage' then
   select * into st from public.sx_stages where number=n;
   if length(btrim(st.clue))=0 then raise exception 'Inserisci prima il testo dell’indovinello'; end if;
   if n=1 and jsonb_array_length(st.objects)<>12 then raise exception 'Inserisci i 12 oggetti'; end if;
   update public.sx_stages set released=true where number=n;
   return jsonb_build_object('ok',true);
 end if;
 if p_action='publish_stage' then
   update public.sx_stages set public_override=coalesce((p_payload->>'published')::boolean,true) where number=n;
   return jsonb_build_object('ok',true);
 end if;
 if p_action='plan_final' then
   if not (select released from public.sx_stages where number=5) then
     raise exception 'Apri prima la quinta tappa'; end if;
   if not exists(select 1 from public.sx_teams) or exists(
       select 1 from public.sx_progress where stage_number<5 and not verified) or exists(
       select 1 from public.sx_progress where stage_number=5 and started_at is not null) then
     raise exception 'Per programmare la finale, convalida le prime quattro prove di tutte le squadre'; end if;
   select min(total_ms) into first_ms from (
     select team_id,sum(round(extract(epoch from (p.ended_at-p.started_at))*1000)::bigint +
      (jsonb_array_length(s.objects)-2*(select count(*) from jsonb_array_elements_text(p.checked) o(x) where x='true'))*300000 +
      (case when (p.hints->>0)::boolean then 900000 else 0 end)+
      (case when (p.hints->>1)::boolean then 1200000 else 0 end))::bigint total_ms
     from public.sx_progress p join public.sx_stages s on s.number=p.stage_number
     where p.stage_number<5 group by team_id) totals;
   update public.sx_progress pf set final_ready_at=clock_timestamp()+interval '30 seconds'+
      (make_interval(secs => (totals.total_ms-first_ms)::double precision/1000.0))
    from (select p.team_id,sum(round(extract(epoch from (p.ended_at-p.started_at))*1000)::bigint +
      (jsonb_array_length(s.objects)-2*(select count(*) from jsonb_array_elements_text(p.checked) o(x) where x='true'))*300000 +
      (case when (p.hints->>0)::boolean then 900000 else 0 end)+
      (case when (p.hints->>1)::boolean then 1200000 else 0 end))::bigint total_ms
     from public.sx_progress p join public.sx_stages s on s.number=p.stage_number
     where p.stage_number<5 group by p.team_id) totals
    where pf.team_id=totals.team_id and pf.stage_number=5;
   return jsonb_build_object('ok',true);
 end if;
 if p_action='gps' or p_action='gps_stop' then
   if r not in ('team','commissioner') or my_id is null then raise exception 'GPS disponibile solo per la propria squadra'; end if;
   if p_action='gps_stop' then
     update public.sx_locations set lat=null,lng=null,accuracy=null,updated_at=null,public_opt_in=false where team_id=my_id;
   else
     v_lat:=(p_payload->>'lat')::double precision; v_lng:=(p_payload->>'lng')::double precision;
     v_acc:=(p_payload->>'accuracy')::double precision;
     if v_lat not between 40.5 and 41.3 or v_lng not between 14 and 15 or v_acc<0 or v_acc>20000 then
       raise exception 'Coordinate non valide'; end if;
     update public.sx_locations set lat=v_lat,lng=v_lng,accuracy=v_acc,updated_at=clock_timestamp(),
       public_opt_in=coalesce((p_payload->>'publicOptIn')::boolean,false) where team_id=my_id;
   end if;
   return jsonb_build_object('ok',true);
 end if;
 if p_action not in ('start','check','request_hint','grant_hint','verify') then
   raise exception 'Azione sconosciuta'; end if;
 target:=coalesce(nullif(p_payload->>'teamId','')::uuid,my_id);
 if target is null or (r<>'admin' and target<>my_id) then raise exception 'Squadra non autorizzata'; end if;
 if p_action in ('start','grant_hint','verify') and r not in ('admin','commissioner') then
   raise exception 'Serve un commissario o un organizzatore'; end if;
 select * into st from public.sx_stages where number=n;
 select * into pr from public.sx_progress where team_id=target and stage_number=n for update;
 if pr.team_id is null then raise exception 'Squadra non trovata'; end if;
 if p_action='start' then
   if not st.released or pr.started_at is not null then raise exception 'Tappa non disponibile'; end if;
   if n>1 and not (select verified from public.sx_progress where team_id=target and stage_number=n-1) then
     raise exception 'Completa prima la tappa precedente'; end if;
   if n=5 and (pr.final_ready_at is null or clock_timestamp()<pr.final_ready_at) then
     raise exception 'Attendi l’orario della partenza scaglionata'; end if;
   update public.sx_progress set started_at=clock_timestamp(),
      checked=(select coalesce(jsonb_agg(false),'[]'::jsonb) from generate_series(1,jsonb_array_length(st.objects)))
     where team_id=target and stage_number=n;
   return jsonb_build_object('ok',true);
 end if;
 if pr.started_at is null or pr.verified then raise exception 'La prova non è in corso'; end if;
 if p_action='check' then
   ix:=(p_payload->>'index')::int;
   if ix is null or ix<0 or ix>=jsonb_array_length(st.objects) then raise exception 'Oggetto non valido'; end if;
   b:=(p_payload->>'checked')::boolean;
   if b is null then raise exception 'Stato oggetto non valido'; end if;
   update public.sx_progress set checked=jsonb_set(checked,array[ix::text],to_jsonb(b))
    where team_id=target and stage_number=n;
   return jsonb_build_object('ok',true);
 end if;
 if p_action='request_hint' or p_action='grant_hint' then
   ix:=(p_payload->>'hint')::int;
   if ix is null or ix not in (0,1) then raise exception 'Aiuto non valido'; end if;
   if clock_timestamp() < pr.started_at + make_interval(mins=>case when ix=0 then 25 else 50 end) then
      raise exception 'Il tempo per richiedere l’aiuto non è ancora trascorso'; end if;
   if p_action='request_hint' then
     update public.sx_progress set requested=jsonb_set(requested,array[ix::text],'true'::jsonb)
     where team_id=target and stage_number=n;
   else
     if not (pr.requested->>ix)::boolean then raise exception 'La squadra non ha richiesto questo aiuto'; end if;
     update public.sx_progress set hints=jsonb_set(hints,array[ix::text],'true'::jsonb)
     where team_id=target and stage_number=n;
   end if;
   return jsonb_build_object('ok',true);
 end if;
 if p_action='verify' then
   update public.sx_progress set ended_at=clock_timestamp(),verified=true where team_id=target and stage_number=n;
   return jsonb_build_object('ok',true);
 end if;
 raise exception 'Azione non gestita';
end $$;

revoke all on function public.sx_login(text),public.sx_state(text),public.sx_action(text,text,jsonb)
 from public,anon,authenticated;
grant execute on function public.sx_login(text),public.sx_state(text),public.sx_action(text,text,jsonb)
 to anon,authenticated;

-- DOPO l'esecuzione, crea una chiave segreta per la regia SOLO nel SQL Editor:
-- insert into public.sx_identity(role,code_hash) values
-- ('admin',encode(extensions.digest('INCOLLA_QUI_UNA_PASSPHRASE_DI_ALMENO_24_CARATTERI','sha256'),'hex'));
-- NON copiare la passphrase nel repository o in site-config.js.
