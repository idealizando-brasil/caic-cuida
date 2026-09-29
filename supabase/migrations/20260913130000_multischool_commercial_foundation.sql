create table public.subscription_plans (
  code text primary key,
  name text not null,
  monthly_price numeric(10,2) not null check (monthly_price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.school_applications (
  id uuid primary key default gen_random_uuid(),
  school_name text not null,
  inep_code text,
  contact_name text not null,
  contact_email text not null,
  contact_phone text not null,
  city text not null,
  state char(2) not null,
  plan_code text not null references public.subscription_plans(code),
  monthly_price numeric(10,2) not null check (monthly_price >= 0),
  status text not null default 'pending' check (status in ('pending','contacted','awaiting_payment','paid','approved','rejected','cancelled')),
  payment_status text not null default 'pending' check (payment_status in ('pending','proof_sent','confirmed','rejected')),
  payment_proof_url text,
  notes text,
  school_id uuid references public.schools(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.school_subscriptions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null unique references public.schools(id) on delete cascade,
  plan_code text not null references public.subscription_plans(code),
  monthly_price numeric(10,2) not null check (monthly_price >= 0),
  billing_day smallint not null default 10 check (billing_day between 1 and 28),
  status public.subscription_status not null default 'onboarding',
  started_at date,
  next_due_date date,
  suspended_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subscription_payments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  subscription_id uuid not null references public.school_subscriptions(id) on delete cascade,
  reference_month date not null check (reference_month = date_trunc('month', reference_month)::date),
  due_date date not null,
  amount numeric(10,2) not null check (amount >= 0),
  status text not null default 'pending' check (status in ('pending','proof_sent','confirmed','overdue','cancelled','refunded')),
  payment_method text not null default 'pix' check (payment_method = 'pix'),
  payment_proof_url text,
  paid_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscription_id, reference_month)
);

alter table public.subscription_plans enable row level security;
alter table public.school_applications enable row level security;
alter table public.school_subscriptions enable row level security;
alter table public.subscription_payments enable row level security;

create policy plans_public_read on public.subscription_plans
for select to anon, authenticated using (active or private.is_platform_admin());

create policy plans_platform_manage on public.subscription_plans
for all to authenticated using (private.is_platform_admin())
with check (private.is_platform_admin());

create policy applications_platform_manage on public.school_applications
for all to authenticated using (private.is_platform_admin())
with check (private.is_platform_admin());

create policy subscriptions_school_read on public.school_subscriptions
for select to authenticated using (
  private.is_platform_admin()
  or private.has_school_role(school_id, array['school_admin','director']::public.app_role[])
);

create policy subscriptions_platform_manage on public.school_subscriptions
for all to authenticated using (private.is_platform_admin())
with check (private.is_platform_admin());

create policy payments_school_read on public.subscription_payments
for select to authenticated using (
  private.is_platform_admin()
  or private.has_school_role(school_id, array['school_admin','director']::public.app_role[])
);

create policy payments_platform_manage on public.subscription_payments
for all to authenticated using (private.is_platform_admin())
with check (private.is_platform_admin());

create index school_applications_status_created_idx
on public.school_applications(status, created_at desc);

create index school_subscriptions_status_due_idx
on public.school_subscriptions(status, next_due_date);

create index subscription_payments_school_due_idx
on public.subscription_payments(school_id, due_date desc);

insert into public.subscription_plans(code, name, monthly_price)
values ('cuida_mensal', 'Sistema CUIDA Mensal', 49.90)
on conflict (code) do update
set name = excluded.name,
    monthly_price = excluded.monthly_price,
    active = true,
    updated_at = now();

insert into public.school_subscriptions(
  school_id, plan_code, monthly_price, status, started_at
)
select id, 'cuida_mensal', 0, 'pilot', current_date
from public.schools
where slug = 'caic'
on conflict (school_id) do nothing;
