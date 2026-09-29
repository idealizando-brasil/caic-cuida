-- Fluxo oficial CUIDA: encaminhamento -> agenda -> atendimento -> retorno/conclusao

-- Metadados de agenda, cancelamento com aceite da gestao e retorno.
alter table public.appointments add column if not exists appointment_type text not null default 'initial';
alter table public.appointments add column if not exists cancellation_reason text;
alter table public.appointments add column if not exists cancellation_requested_by uuid references public.profiles(id);
alter table public.appointments add column if not exists cancellation_requested_at timestamptz;
alter table public.appointments add column if not exists cancellation_decision text;
alter table public.appointments add column if not exists cancellation_decided_by uuid references public.profiles(id);
alter table public.appointments add column if not exists cancellation_decided_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='appointments_type_check') then
    alter table public.appointments add constraint appointments_type_check check (appointment_type in ('initial','return')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='appointments_cancel_decision_check') then
    alter table public.appointments add constraint appointments_cancel_decision_check check (cancellation_decision is null or cancellation_decision in ('approved','rejected')) not valid;
  end if;
end $$;
alter table public.appointments validate constraint appointments_type_check;
alter table public.appointments validate constraint appointments_cancel_decision_check;

-- Novos agendamentos obrigatoriamente nascem de um encaminhamento do mesmo aluno/escola.
create or replace function private.validate_appointment_referral()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.referral_id is null then raise exception 'Agendamento exige encaminhamento'; end if;
  if not exists (select 1 from public.referrals r where r.id=new.referral_id and r.school_id=new.school_id and r.student_id=new.student_id and r.status <> 'completed') then
    raise exception 'Encaminhamento invalido para este aluno';
  end if;
  return new;
end $$;
drop trigger if exists validate_appointment_referral on public.appointments;
create trigger validate_appointment_referral before insert or update of referral_id,student_id,school_id on public.appointments for each row execute function private.validate_appointment_referral();

-- Cancelamento definitivo nunca pode ser feito diretamente pela Equipe Multiprofissional.
create or replace function private.protect_appointment_cancellation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.status is distinct from 'cancelled' and new.status='cancelled' and not private.has_school_role(new.school_id,array['director','coordinator']::public.app_role[]) then
    raise exception 'Cancelamento exige aprovacao da Direcao ou Coordenacao';
  end if;
  return new;
end $$;
drop trigger if exists protect_appointment_cancellation on public.appointments;
create trigger protect_appointment_cancellation before update of status on public.appointments for each row execute function private.protect_appointment_cancellation();

-- Agenda: leitura pela equipe autorizada; escrita operacional somente Psicologia/Servico Social.
drop policy if exists staff_appointments on public.appointments;
drop policy if exists appointments_read on public.appointments;
drop policy if exists appointments_insert on public.appointments;
drop policy if exists appointments_update on public.appointments;
drop policy if exists appointments_delete on public.appointments;
create policy appointments_read on public.appointments for select to authenticated using(private.has_school_role(school_id,array['director','coordinator','psychologist','social_worker']::public.app_role[]));
create policy appointments_insert on public.appointments for insert to authenticated with check(professional_id=auth.uid() and private.has_school_role(school_id,array['psychologist','social_worker']::public.app_role[]));
create policy appointments_update on public.appointments for update to authenticated using(professional_id=auth.uid() and private.has_school_role(school_id,array['psychologist','social_worker']::public.app_role[])) with check(professional_id=auth.uid() and private.has_school_role(school_id,array['psychologist','social_worker']::public.app_role[]));

-- Atendimento sempre exige agendamento e encaminhamento coerentes.
create or replace function private.validate_attendance_flow()
returns trigger language plpgsql security definer set search_path='' as $$
declare ap public.appointments%rowtype;
begin
  if new.appointment_id is null or new.referral_id is null then raise exception 'Atendimento exige agendamento e encaminhamento'; end if;
  select * into ap from public.appointments where id=new.appointment_id;
  if not found or ap.school_id<>new.school_id or ap.student_id<>new.student_id or ap.referral_id<>new.referral_id or ap.professional_id<>new.author_id then
    raise exception 'Agendamento invalido para este atendimento';
  end if;
  if ap.status in ('cancelled','absent') then raise exception 'Agendamento cancelado ou com ausencia nao pode gerar atendimento'; end if;
  return new;
end $$;
drop trigger if exists validate_attendance_flow on public.attendances;
create trigger validate_attendance_flow before insert or update of appointment_id,referral_id,student_id,school_id,author_id on public.attendances for each row execute function private.validate_attendance_flow();

-- Somente a Equipe Multiprofissional registra atendimentos.
drop policy if exists attendances_insert on public.attendances;
create policy attendances_insert on public.attendances for insert to authenticated with check(author_id=auth.uid() and private.has_school_role(school_id,array['psychologist','social_worker']::public.app_role[]));

-- Escuta Ativa / Demanda: sigilo individual. Somente o autor do atendimento pode ler.
drop policy if exists private_demands_read_team on public.attendance_private_demands;
drop policy if exists private_demands_read_own on public.attendance_private_demands;
create policy private_demands_read_own on public.attendance_private_demands for select to authenticated using(author_id=auth.uid());

-- Solicitacao de cancelamento pela profissional; decisao exclusiva da Direcao/Coordenacao.
create or replace function public.request_appointment_cancellation(p_appointment uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare ap public.appointments%rowtype;
begin
  select * into ap from public.appointments where id=p_appointment;
  if not found or ap.professional_id<>auth.uid() or not private.has_school_role(ap.school_id,array['psychologist','social_worker']::public.app_role[]) then raise exception 'Sem permissao'; end if;
  if ap.status<>'scheduled' then raise exception 'Somente agendamento ativo pode solicitar cancelamento'; end if;
  if trim(coalesce(p_reason,''))='' then raise exception 'Justificativa obrigatoria'; end if;
  update public.appointments set status='cancellation_requested',cancellation_reason=trim(p_reason),cancellation_requested_by=auth.uid(),cancellation_requested_at=now(),cancellation_decision=null,cancellation_decided_by=null,cancellation_decided_at=null where id=p_appointment;
end $$;

create or replace function public.decide_appointment_cancellation(p_appointment uuid,p_approve boolean)
returns void language plpgsql security definer set search_path='' as $$
declare ap public.appointments%rowtype;
begin
  select * into ap from public.appointments where id=p_appointment;
  if not found or not private.has_school_role(ap.school_id,array['director','coordinator']::public.app_role[]) then raise exception 'Sem permissao'; end if;
  if ap.status<>'cancellation_requested' then raise exception 'Nao ha cancelamento pendente'; end if;
  update public.appointments set status=case when p_approve then 'cancelled' else 'scheduled' end,cancellation_decision=case when p_approve then 'approved' else 'rejected' end,cancellation_decided_by=auth.uid(),cancellation_decided_at=now() where id=p_appointment;
end $$;

grant execute on function public.request_appointment_cancellation(uuid,text) to authenticated;
grant execute on function public.decide_appointment_cancellation(uuid,boolean) to authenticated;

-- Um agendamento nao pode gerar dois registros de atendimento.
create unique index if not exists attendances_one_per_appointment_idx on public.attendances(appointment_id) where appointment_id is not null;
