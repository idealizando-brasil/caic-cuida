-- Registros retroativos de atendimentos multiprofissionais.
-- Preserva a data real do atendimento e a data atual de lancamento, sem retroagir created_at.

alter table public.attendances
  add column if not exists occurred_at timestamptz,
  add column if not exists is_retroactive boolean not null default false,
  add column if not exists attendance_area text,
  add column if not exists attendance_type text,
  add column if not exists record_origin text,
  add column if not exists requires_current_follow_up boolean not null default false;

update public.attendances a
set occurred_at = coalesce(
  (select ap.starts_at from public.appointments ap where ap.id = a.appointment_id),
  a.created_at
)
where a.occurred_at is null;

alter table public.attendances
  alter column occurred_at set default now(),
  alter column occurred_at set not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='attendances_area_check') then
    alter table public.attendances add constraint attendances_area_check
      check (attendance_area is null or attendance_area in ('psychology','social_work','joint')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='attendances_type_check') then
    alter table public.attendances add constraint attendances_type_check
      check (attendance_type is null or attendance_type in ('listening','guidance','family_contact','family_visit','network_coordination','other')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='attendances_origin_check') then
    alter table public.attendances add constraint attendances_origin_check
      check (record_origin is null or record_origin in ('scheduled','historical_record','spontaneous','previous_referral')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='attendances_occurred_not_future_check') then
    alter table public.attendances add constraint attendances_occurred_not_future_check
      check (occurred_at <= now() + interval '5 minutes') not valid;
  end if;
end $$;

alter table public.attendances validate constraint attendances_area_check;
alter table public.attendances validate constraint attendances_type_check;
alter table public.attendances validate constraint attendances_origin_check;
alter table public.attendances validate constraint attendances_occurred_not_future_check;

-- O fluxo normal continua exigindo agenda e encaminhamento.
-- O registro retroativo dispensa agenda, mas valida aluno, escola, autoria e data.
create or replace function private.validate_attendance_flow()
returns trigger language plpgsql security definer set search_path='' as $$
declare ap public.appointments%rowtype;
begin
  if new.is_retroactive then
    if new.appointment_id is not null then
      raise exception 'Registro retroativo nao pode alterar um agendamento';
    end if;
    if new.occurred_at > now() + interval '5 minutes' then
      raise exception 'A data do atendimento nao pode estar no futuro';
    end if;
    if not exists (
      select 1 from public.students s
      where s.id=new.student_id and s.school_id=new.school_id
    ) then
      raise exception 'Aluno invalido para esta escola';
    end if;
    if new.referral_id is not null and not exists (
      select 1 from public.referrals r
      where r.id=new.referral_id and r.school_id=new.school_id and r.student_id=new.student_id
    ) then
      raise exception 'Encaminhamento invalido para este aluno';
    end if;
  else
    if new.appointment_id is null or new.referral_id is null then
      raise exception 'Atendimento exige agendamento e encaminhamento';
    end if;
    select * into ap from public.appointments where id=new.appointment_id;
    if not found or ap.school_id<>new.school_id or ap.student_id<>new.student_id or ap.referral_id<>new.referral_id or ap.professional_id<>new.author_id then
      raise exception 'Agendamento invalido para este atendimento';
    end if;
    if ap.status in ('cancelled','absent') then
      raise exception 'Agendamento cancelado ou com ausencia nao pode gerar atendimento';
    end if;
    new.occurred_at := ap.starts_at;
    new.record_origin := 'scheduled';
  end if;
  return new;
end $$;

drop trigger if exists validate_attendance_flow on public.attendances;
create trigger validate_attendance_flow
before insert or update of appointment_id,referral_id,student_id,school_id,author_id,is_retroactive,occurred_at
on public.attendances for each row execute function private.validate_attendance_flow();

-- O conteudo sigiloso e comum exclusivamente a Psicologia e Assistencia Social.
drop policy if exists private_demands_read_own on public.attendance_private_demands;
drop policy if exists private_demands_read_team on public.attendance_private_demands;
create policy private_demands_read_team
on public.attendance_private_demands for select to authenticated
using (
  private.has_school_role(
    school_id,
    array['psychologist','social_worker']::public.app_role[]
  )
);

-- Criacao atomica: parte institucional + escuta sigilosa.
create or replace function public.create_retroactive_attendance(
  p_school_id uuid,
  p_student_id uuid,
  p_occurred_at timestamptz,
  p_area text,
  p_type text,
  p_origin text,
  p_private_demand text,
  p_guidance_referrals text,
  p_requires_current_follow_up boolean default false
)
returns uuid
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or not private.has_school_role(
    p_school_id,
    array['psychologist','social_worker']::public.app_role[]
  ) then
    raise exception 'Sem permissao para registrar atendimento';
  end if;
  if p_occurred_at is null or p_occurred_at > now() + interval '5 minutes' then
    raise exception 'Data real do atendimento invalida';
  end if;
  if trim(coalesce(p_private_demand,''))='' or trim(coalesce(p_guidance_referrals,''))='' then
    raise exception 'Escuta e orientacoes sao obrigatorias';
  end if;

  insert into public.attendances(
    school_id,student_id,author_id,guidance_referrals,occurred_at,is_retroactive,
    attendance_area,attendance_type,record_origin,requires_current_follow_up
  ) values (
    p_school_id,p_student_id,auth.uid(),trim(p_guidance_referrals),p_occurred_at,true,
    p_area,p_type,p_origin,coalesce(p_requires_current_follow_up,false)
  ) returning id into v_id;

  insert into public.attendance_private_demands(
    attendance_id,school_id,author_id,demand
  ) values (
    v_id,p_school_id,auth.uid(),trim(p_private_demand)
  );

  return v_id;
end $$;

revoke all on function public.create_retroactive_attendance(uuid,uuid,timestamptz,text,text,text,text,text,boolean) from public;
grant execute on function public.create_retroactive_attendance(uuid,uuid,timestamptz,text,text,text,text,text,boolean) to authenticated;

create or replace function private.audit_retroactive_attendance()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.is_retroactive then
    insert into public.audit_logs(school_id,user_id,action,entity_type,entity_id,metadata)
    values (
      new.school_id,
      new.author_id,
      'create_retroactive_attendance',
      'attendance',
      new.id,
      jsonb_build_object(
        'occurred_at',new.occurred_at,
        'recorded_at',new.created_at,
        'student_id',new.student_id,
        'requires_current_follow_up',new.requires_current_follow_up
      )
    );
  end if;
  return new;
end $$;

revoke all on function private.audit_retroactive_attendance() from public;
revoke all on function private.audit_retroactive_attendance() from authenticated;

drop trigger if exists audit_retroactive_attendance on public.attendances;
create trigger audit_retroactive_attendance
after insert on public.attendances
for each row execute function private.audit_retroactive_attendance();

create index if not exists attendances_school_occurred_idx
  on public.attendances(school_id,occurred_at desc);

comment on column public.attendances.occurred_at is 'Data e hora reais em que o atendimento ocorreu.';
comment on column public.attendances.created_at is 'Data e hora imutaveis em que o registro foi lancado no CUIDA.';
