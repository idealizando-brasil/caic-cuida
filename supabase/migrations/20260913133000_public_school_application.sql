create or replace function public.submit_school_application(
  p_school_name text,
  p_inep_code text,
  p_contact_name text,
  p_contact_email text,
  p_contact_phone text,
  p_city text,
  p_state text,
  p_website text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  application_id uuid;
  plan_price numeric(10,2);
begin
  if length(trim(p_school_name)) not between 3 and 160
    or length(trim(p_contact_name)) not between 3 and 160
    or length(trim(p_contact_email)) not between 5 and 254
    or p_contact_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
    or length(regexp_replace(p_contact_phone, '\D', '', 'g')) not between 10 and 13
    or length(trim(p_city)) not between 2 and 120
    or upper(trim(p_state)) !~ '^[A-Z]{2}$'
    or coalesce(length(trim(p_website)), 0) > 0
  then
    raise exception 'Dados inválidos';
  end if;

  if exists (
    select 1 from public.school_applications
    where lower(contact_email) = lower(trim(p_contact_email))
      and created_at > now() - interval '15 minutes'
  ) then
    raise exception 'Solicitação já recebida. Aguarde o contato da equipe.';
  end if;

  select monthly_price into plan_price
  from public.subscription_plans
  where code = 'cuida_mensal' and active;

  if plan_price is null then
    raise exception 'Plano indisponível';
  end if;

  insert into public.school_applications(
    school_name, inep_code, contact_name, contact_email, contact_phone,
    city, state, plan_code, monthly_price
  ) values (
    trim(p_school_name), nullif(trim(p_inep_code), ''), trim(p_contact_name),
    lower(trim(p_contact_email)), trim(p_contact_phone), trim(p_city),
    upper(trim(p_state)), 'cuida_mensal', plan_price
  ) returning id into application_id;

  return application_id;
end;
$$;

revoke all on function public.submit_school_application(text,text,text,text,text,text,text,text) from public;
grant execute on function public.submit_school_application(text,text,text,text,text,text,text,text) to anon, authenticated;
