-- SAVIANO EXPRESS · Upgrade credenziali (senza perdita dei risultati).
-- Eseguire in Supabase SQL Editor UNA SOLA VOLTA sul progetto già esistente.
-- NON rieseguire backend/setup.sql: contiene CREATE TABLE e fallirebbe.
-- Non inserire password né token reali in questo file.

create or replace function public.sx_rotate_code(
  p_token text,
  p_team_id uuid,
  p_role text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor_role text;
  v_identity_id bigint;
  v_new_code text;
begin
  select actor_role into v_actor_role from public.sx_who(p_token);
  if v_actor_role is distinct from 'admin' then
    raise exception 'Azione riservata alla regia';
  end if;
  if p_role is null or p_role not in ('team','commissioner') or p_team_id is null then
    raise exception 'Squadra o ruolo non validi';
  end if;

  -- Blocca la credenziale interessata; non tocca il record squadra o le prove.
  select i.id into v_identity_id
    from public.sx_identity i
   where i.team_id = p_team_id and i.role = p_role
   for update;
  if v_identity_id is null then
    raise exception 'Credenziale non trovata per questa squadra';
  end if;

  v_new_code := encode(extensions.gen_random_bytes(18),'hex');
  update public.sx_identity
     set code_hash = encode(extensions.digest(v_new_code,'sha256'),'hex')
   where id = v_identity_id;

  -- Invalida accessi già effettuati con la credenziale sostituita.
  delete from public.sx_sessions where identity_id = v_identity_id;

  -- Il nuovo codice in chiaro viene restituito UNA SOLA VOLTA alla regia.
  return jsonb_build_object('ok',true,'role',p_role,'teamId',p_team_id,'code',v_new_code);
end
$$;

revoke all on function public.sx_rotate_code(text,uuid,text)
  from public, anon, authenticated;
grant execute on function public.sx_rotate_code(text,uuid,text)
  to anon,authenticated;
