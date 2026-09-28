-- ============================================================
-- INVESTMENT ACCOUNTING SYSTEM — CLEAN DATABASE v1.3
-- ============================================================
-- Run this ENTIRE file once in the SQL Editor of the NEW
-- Supabase project. It is intentionally self-contained.
-- ============================================================

create extension if not exists "pgcrypto";

-- Clean start for this project only.
drop view if exists public.portfolio_holdings cascade;
drop table if exists public.fair_value_adjustments cascade;
drop table if exists public.journal_entries cascade;
drop table if exists public.dividends cascade;
drop table if exists public.investment_transactions cascade;
drop table if exists public.securities cascade;
drop function if exists public.sync_security_price_from_fva() cascade;

-- ============================================================
-- SECURITIES
-- ============================================================
create table public.securities (
  id uuid primary key default gen_random_uuid(),
  ticker text not null unique,
  company_name text not null,
  sector text,
  last_price numeric(18,2) not null default 0,
  created_at timestamptz not null default now()
);

-- ============================================================
-- INVESTMENT TRANSACTIONS
-- ============================================================
create table public.investment_transactions (
  id uuid primary key default gen_random_uuid(),
  security_id uuid not null references public.securities(id) on delete restrict,
  transaction_type text not null check (transaction_type in ('BUY','SELL')),
  transaction_date date not null,
  quantity numeric(18,4) not null check (quantity > 0),
  price numeric(18,2) not null check (price >= 0),
  broker_fee numeric(18,2) not null default 0 check (broker_fee >= 0),
  reference_no text not null unique,
  created_at timestamptz not null default now()
);

-- ============================================================
-- DIVIDENDS
-- ============================================================
create table public.dividends (
  id uuid primary key default gen_random_uuid(),
  security_id uuid not null references public.securities(id) on delete restrict,
  payment_date date not null,
  shares numeric(18,4) not null check (shares > 0),
  dividend_per_share numeric(18,2) not null check (dividend_per_share >= 0),
  total_amount numeric(18,2) not null check (total_amount >= 0),
  reference_no text not null unique,
  created_at timestamptz not null default now()
);

-- ============================================================
-- JOURNAL ENTRIES
-- security_id is nullable because some manual/general journal
-- entries may not relate to a single security.
-- ============================================================
create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  reference_no text not null,
  security_id uuid references public.securities(id) on delete set null,
  description text,
  account_name text not null,
  debit numeric(18,2) not null default 0 check (debit >= 0),
  credit numeric(18,2) not null default 0 check (credit >= 0),
  created_at timestamptz not null default now(),
  check (not (debit > 0 and credit > 0))
);

-- ============================================================
-- FAIR VALUE ADJUSTMENTS
-- One row = one security's year-end fair value measurement.
-- The journal created by the frontend is the accounting record.
-- ============================================================
create table public.fair_value_adjustments (
  id uuid primary key default gen_random_uuid(),
  adjustment_date date not null,
  security_id uuid not null references public.securities(id) on delete restrict,
  shares numeric(18,4) not null check (shares > 0),
  market_price numeric(18,4) not null check (market_price >= 0),
  carrying_amount_before numeric(20,2) not null default 0,
  fair_value numeric(20,2) not null default 0,
  adjustment_amount numeric(20,2) not null default 0,
  reference_no text not null unique,
  created_at timestamptz not null default now(),
  unique (adjustment_date, security_id)
);

-- ============================================================
-- INDEXES
-- ============================================================
create index idx_transactions_date on public.investment_transactions(transaction_date desc);
create index idx_transactions_security on public.investment_transactions(security_id);
create index idx_dividends_date on public.dividends(payment_date desc);
create index idx_dividends_security on public.dividends(security_id);
create index idx_journal_date on public.journal_entries(entry_date desc);
create index idx_journal_reference on public.journal_entries(reference_no);
create index idx_journal_security on public.journal_entries(security_id);
create index idx_fva_date on public.fair_value_adjustments(adjustment_date desc);
create index idx_fva_security on public.fair_value_adjustments(security_id);

-- ============================================================
-- DEMO SECURITIES
-- ============================================================
insert into public.securities (ticker, company_name, sector, last_price) values
('BBCA','Bank Central Asia Tbk','Financials',8800),
('BBRI','Bank Rakyat Indonesia (Persero) Tbk','Financials',3950),
('BMRI','Bank Mandiri (Persero) Tbk','Financials',5150),
('ANTM','Aneka Tambang Tbk','Basic Materials',3150),
('TLKM','Telkom Indonesia (Persero) Tbk','Telecommunication',2850),
('ASII','Astra International Tbk','Industrials',5100);

-- ============================================================
-- PORTFOLIO VIEW
-- ============================================================
create or replace view public.portfolio_holdings as
select
  s.id as security_id,
  s.ticker,
  s.company_name,
  s.sector,
  s.last_price,
  coalesce(sum(case
    when t.transaction_type='BUY' then t.quantity
    when t.transaction_type='SELL' then -t.quantity
    else 0 end),0) as shares
from public.securities s
left join public.investment_transactions t on t.security_id=s.id
group by s.id,s.ticker,s.company_name,s.sector,s.last_price;

-- ============================================================
-- FVA -> SECURITY LAST PRICE SYNC
-- ============================================================
-- The frontend uses securities.last_price for the Portfolio and
-- Market Value. Posting an FVA therefore updates last_price.
-- Deleting the latest FVA restores the previous FVA price.
create or replace function public.sync_security_price_from_fva()
returns trigger
language plpgsql
as $$
declare
  v_security_id uuid;
  v_price numeric(18,4);
  v_found boolean;
begin
  v_security_id := coalesce(new.security_id, old.security_id);

  select f.market_price, true
    into v_price, v_found
  from public.fair_value_adjustments f
  where f.security_id = v_security_id
  order by f.adjustment_date desc, f.created_at desc
  limit 1;

  if coalesce(v_found, false) then
    update public.securities
       set last_price = v_price
     where id = v_security_id;
  else
    update public.securities
       set last_price = 0
     where id = v_security_id;
  end if;

  return coalesce(new, old);
end;
$$;

create trigger trg_sync_security_price_from_fva
after insert or update or delete on public.fair_value_adjustments
for each row execute function public.sync_security_price_from_fva();

-- ============================================================
-- RLS — CLASSROOM / DEMO MODE
-- ============================================================
-- The frontend uses the publishable key directly, so public CRUD
-- policies are intentionally used for this classroom/demo project.
-- For production, add Supabase Auth and user/company-scoped RLS.

alter table public.securities enable row level security;
alter table public.investment_transactions enable row level security;
alter table public.dividends enable row level security;
alter table public.journal_entries enable row level security;
alter table public.fair_value_adjustments enable row level security;

create policy "demo read securities" on public.securities for select using (true);
create policy "demo insert securities" on public.securities for insert with check (true);
create policy "demo update securities" on public.securities for update using (true) with check (true);
create policy "demo delete securities" on public.securities for delete using (true);

create policy "demo read transactions" on public.investment_transactions for select using (true);
create policy "demo insert transactions" on public.investment_transactions for insert with check (true);
create policy "demo update transactions" on public.investment_transactions for update using (true) with check (true);
create policy "demo delete transactions" on public.investment_transactions for delete using (true);

create policy "demo read dividends" on public.dividends for select using (true);
create policy "demo insert dividends" on public.dividends for insert with check (true);
create policy "demo update dividends" on public.dividends for update using (true) with check (true);
create policy "demo delete dividends" on public.dividends for delete using (true);

create policy "demo read journals" on public.journal_entries for select using (true);
create policy "demo insert journals" on public.journal_entries for insert with check (true);
create policy "demo update journals" on public.journal_entries for update using (true) with check (true);
create policy "demo delete journals" on public.journal_entries for delete using (true);

create policy "demo read fva" on public.fair_value_adjustments for select using (true);
create policy "demo insert fva" on public.fair_value_adjustments for insert with check (true);
create policy "demo update fva" on public.fair_value_adjustments for update using (true) with check (true);
create policy "demo delete fva" on public.fair_value_adjustments for delete using (true);

-- Make sure PostgREST sees the freshly-created tables and relationships.
notify pgrst, 'reload schema';
