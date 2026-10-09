-- HCMC flood map — crowd reports schema. Run once in the Supabase SQL editor (safe to re-run).
--
-- Before using the app:
--   1. Authentication → Sign In / Providers → enable "Allow anonymous sign-ins".
--   2. Production: enable CAPTCHA protection (Cloudflare Turnstile) for anonymous sign-ins — ONLY after the site key
--      is deployed in public/config.js (README §19a order), otherwise every new sign-in fails.

create extension if not exists pgcrypto;

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  lat double precision not null check (lat between 10.66 and 10.90),
  lng double precision not null check (lng between 106.58 and 106.84),
  level smallint not null check (level between 0 and 3),
  created_at timestamptz not null default now()
);

-- Weather captured client-side at report time (see README: spoofable, re-validate before training).
alter table public.reports add column if not exists snapshot jsonb;
alter table public.reports drop constraint if exists reports_snapshot_size;
alter table public.reports add constraint reports_snapshot_size
  check (snapshot is null or octet_length(snapshot::text) < 16384);

-- When the flooding was observed (user-chosen, may be up to 48h before created_at; validated by trigger).
alter table public.reports add column if not exists observed_at timestamptz;
update public.reports set observed_at = created_at where observed_at is null;
alter table public.reports alter column observed_at set default now();
alter table public.reports alter column observed_at set not null;

-- Owner edits / soft withdrawal (§12). All three are server-owned (set by triggers).
alter table public.reports add column if not exists edited_at timestamptz;
alter table public.reports add column if not exists edit_count smallint not null default 0;
alter table public.reports add column if not exists withdrawn_at timestamptz;

create index if not exists reports_created_at_idx on public.reports (created_at desc);
create index if not exists reports_user_created_idx on public.reports (user_id, created_at desc);

create table if not exists public.votes (
  report_id uuid not null references public.reports (id) on delete cascade,
  user_id uuid not null default auth.uid(),
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)
);
alter table public.votes add column if not exists updated_at timestamptz not null default now();

create or replace view public.reports_with_votes
with (security_invoker = true) as
select
  r.id, r.user_id, r.lat, r.lng, r.level, r.created_at,
  count(v.*) filter (where v.value = 1)::int as confirms,
  count(v.*) filter (where v.value = -1)::int as denies,
  r.snapshot,
  r.observed_at,
  r.edit_count,
  r.edited_at
from public.reports r
left join public.votes v on v.report_id = r.id
-- 96 h: 48 h of late reporting + up to 36 h of TTL/fade (§18), so the 48 h-back timeline still shows them.
where r.created_at > now() - interval '96 hours' and r.withdrawn_at is null
group by r.id;

-- Replaced by flood_cells (§18, below).
drop view if exists public.reports_history;

alter table public.reports enable row level security;
alter table public.votes enable row level security;

drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports
  for select to anon, authenticated using (true);

drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert to authenticated with check (user_id = auth.uid());

-- Owner may edit or withdraw; the reports_edit trigger enforces what may change. No DELETE policy (soft delete only).
drop policy if exists reports_update on public.reports;
create policy reports_update on public.reports
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists votes_select on public.votes;
create policy votes_select on public.votes
  for select to anon, authenticated using (true);

drop policy if exists votes_insert on public.votes;
create policy votes_insert on public.votes
  for insert to authenticated with check (
    user_id = auth.uid()
    and not exists (select 1 from public.reports r where r.id = report_id and r.user_id = auth.uid())
  );

drop policy if exists votes_update on public.votes;
create policy votes_update on public.votes
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and not exists (select 1 from public.reports r where r.id = report_id and r.user_id = auth.uid())
  );

create or replace function public.reports_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.reports
    where user_id = new.user_id and created_at > now() - interval '60 seconds'
  ) or (
    select count(*) from public.reports
    where user_id = new.user_id and created_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  new.edited_at := null;
  new.edit_count := 0;
  new.withdrawn_at := null;
  new.created_at := now();  -- never trust a client timestamp (rate limit + TTL depend on it)
  new.observed_at := coalesce(new.observed_at, now());
  if new.observed_at > now() + interval '2 minutes' or new.observed_at < now() - interval '48 hours' then
    raise exception 'invalid_time' using errcode = 'P0001';
  end if;
  new.observed_at := least(new.observed_at, now());
  -- Late report (observed > 15 min before sending): at most 3 per user per 24h.
  if now() - new.observed_at > interval '15 minutes' and (
    select count(*) from public.reports
    where user_id = new.user_id and created_at > now() - interval '24 hours'
      and created_at - observed_at > interval '15 minutes'
  ) >= 3 then
    raise exception 'late_limited' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists reports_rate_limit on public.reports;
create trigger reports_rate_limit
  before insert on public.reports
  for each row execute function public.reports_rate_limit();

-- Owner edit (§12): only before any vote, at most 5 times, observed_at in [created_at − 48h, created_at].
-- Withdrawal (only withdrawn_at set, nothing else changed) is allowed even with votes.
create or replace function public.reports_edit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.id := old.id;
  new.user_id := old.user_id;
  new.created_at := old.created_at;
  new.edited_at := old.edited_at;
  new.edit_count := old.edit_count;
  if old.withdrawn_at is not null then
    raise exception 'withdrawn' using errcode = 'P0001';
  end if;
  if new.withdrawn_at is not null then
    if (new.lat, new.lng, new.level, new.observed_at, new.snapshot::text)
       is distinct from (old.lat, old.lng, old.level, old.observed_at, old.snapshot::text) then
      raise exception 'withdraw_only' using errcode = 'P0001';
    end if;
    new.withdrawn_at := now();
    return new;
  end if;
  if exists (select 1 from public.votes where report_id = old.id) then
    raise exception 'has_votes' using errcode = 'P0001';
  end if;
  if old.edit_count >= 5 then
    raise exception 'edit_limit' using errcode = 'P0001';
  end if;
  if new.observed_at > old.created_at + interval '2 minutes' or new.observed_at < old.created_at - interval '48 hours' then
    raise exception 'invalid_time' using errcode = 'P0001';
  end if;
  new.observed_at := least(new.observed_at, old.created_at);
  -- Turning a normal report into a late one counts against the 3 late reports / 24h.
  if old.created_at - new.observed_at > interval '15 minutes'
     and old.created_at - old.observed_at <= interval '15 minutes' and (
    select count(*) from public.reports
    where user_id = old.user_id and id <> old.id and created_at > now() - interval '24 hours'
      and created_at - observed_at > interval '15 minutes'
  ) >= 3 then
    raise exception 'late_limited' using errcode = 'P0001';
  end if;
  new.edited_at := now();
  new.edit_count := old.edit_count + 1;
  return new;
end;
$$;

drop trigger if exists reports_edit on public.reports;
create trigger reports_edit
  before update on public.reports
  for each row execute function public.reports_edit();

-- Server-owned vote timestamps: created_at = first vote, updated_at = last change (training labels).
create or replace function public.votes_stamp()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.report_id := old.report_id;
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists votes_stamp on public.votes;
create trigger votes_stamp
  before insert or update on public.votes
  for each row execute function public.votes_stamp();

grant select on public.reports_with_votes to anon, authenticated;
grant select, insert, update on public.reports to authenticated;
grant select on public.reports to anon;
grant select, insert, update on public.votes to authenticated;
grant select on public.votes to anon;

-- Realtime: broadcast inserts/updates on reports and votes.
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['reports', 'votes'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- News reports (§16): heavy flood mentions from the daily press scan (scripts/fetch-news.mjs).
-- Everyone may read; only the service role (which bypasses RLS) writes.
create table if not exists public.news_reports (
  id text primary key,
  level smallint not null check (level in (2, 3)),
  cause text check (cause in ('rain', 'tide', 'both')),
  street text not null,
  observed_at timestamptz,
  published_at timestamptz not null,
  signals text[] not null default '{}',
  geometry jsonb not null,
  sources jsonb not null
);

alter table public.news_reports enable row level security;

drop policy if exists news_reports_select on public.news_reports;
create policy news_reports_select on public.news_reports
  for select to anon, authenticated using (true);

revoke insert, update, delete on public.news_reports from anon, authenticated;
grant select on public.news_reports to anon, authenticated;

-- §18 post-event enrichment (scripts/enrich-reports.mjs, daily): re-analysed rain 3 h at the report's point and hour.
-- Everyone may read; only the service role (which bypasses RLS) writes.
create table if not exists public.report_enrichment (
  report_id uuid primary key references public.reports (id) on delete cascade,
  r3_obs double precision,
  source text not null,
  fetched_at timestamptz not null default now()
);

-- §19b observed Phú An level (m, Hòn Dấu) at observed_at, from public/data/tide-phuan.json bulletins.
alter table public.report_enrichment add column if not exists pa_obs double precision;

alter table public.report_enrichment enable row level security;

drop policy if exists report_enrichment_select on public.report_enrichment;
create policy report_enrichment_select on public.report_enrichment
  for select to anon, authenticated using (true);

revoke insert, update, delete on public.report_enrichment from anon, authenticated;
grant select on public.report_enrichment to anon, authenticated;

-- Number at a jsonb path, null when missing or not a number (snapshots are client-written: never cast blindly).
create or replace function public.jsonb_num(j jsonb, path text[])
returns double precision
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when jsonb_typeof(j #> path) = 'number' then (j #>> path)::double precision end
$$;

-- §18 long-term history per ~150 m cell (grid 0.00135°, same as public/js/cells.js), last 730 days:
-- valid reports (not withdrawn, not denied, with a snapshot) + news_reports. Each event:
-- {id, source, lat, lng, t, level, net, Rh, RhSrc, PAh, cause, radarMmH, trust, evidence[, outlet]} where
-- Rh = Rh_eff = max(ECMWF R3, GFS R3, radar 1-h accumulation mm, enrichment r3_obs) and RhSrc names the winner.
-- Radar term = snapshot radar.accumMm (client: Σ mmH × actual frame spacing, 60 min before observed_at) when present,
-- else Σ radar.frames[*].mmH / 6 for old snapshots (ASSUMES 10-min RainViewer frames; frames are already the hour
-- before observed_at). Mirror of public/js/cells.js reportEvent / radar-rate.js radarAccumMm. radarMmH = peak rate (display).
-- Reports carry cause null (the client applies the rain/tide rule); news events carry no weather of their own.
--
-- §19b trust — MIRROR of public/js/trust.js evidenceOf (keep thresholds, distance formula and order identical;
-- the numbers are FLOOD_CONFIG.crowd EVIDENCE_RAIN_MM = 3, EVIDENCE_TIDE_M = 1.40, CORROBORATE_M = 150, CORROBORATE_H = 3):
--   news → 'press'; r3_obs ≥ 3 → 'obs_rain'; pa_obs ≥ 1.40 → 'obs_tide';
--   another user's valid report (this CTE already drops withdrawn/denied) or a news item within 150 m
--   (equirectangular, 111320 m/°) and ±3 h → 'corroborated';
--   only when NOT enriched (no report_enrichment row): snapshot max(ECMWF, GFS, radar) ≥ 3 → 'client_rain',
--   snapshot Phú An ≥ 1.40 → 'client_tide'; else null.
--   trust = press/obs_*/corroborated → 'trusted', client_* → 'provisional', null → 'untrusted' (client does not learn).
create or replace view public.flood_cells
with (security_invoker = true) as
with report_ev as (
  select
    r.id, r.user_id, r.lat, r.lng, r.observed_at, r.level,
    (count(v.*) filter (where v.value = 1) - count(v.*) filter (where v.value = -1))::int as net,
    public.jsonb_num(r.snapshot, '{features,ecmwf_ifs,R3}') as ecmwf,
    public.jsonb_num(r.snapshot, '{features,gfs_global,R3}') as gfs,
    coalesce(public.jsonb_num(r.snapshot, '{radar,accumMm}'),
      (select round((sum(coalesce(public.jsonb_num(f, '{mmH}'), 0)) / 6)::numeric, 2)::double precision
         from jsonb_array_elements(case when jsonb_typeof(r.snapshot #> '{radar,frames}') = 'array'
                                        then r.snapshot #> '{radar,frames}' else '[]'::jsonb end) f)) as radar,
    public.jsonb_num(r.snapshot, '{radar,maxMmH}') as radar_max,
    public.jsonb_num(r.snapshot, '{tide,phuAn}') as pa,
    e.r3_obs, e.pa_obs, (e.report_id is not null) as enriched
  from public.reports r
  left join public.votes v on v.report_id = r.id
  left join public.report_enrichment e on e.report_id = r.id
  where r.withdrawn_at is null and r.snapshot is not null and r.observed_at > now() - interval '730 days'
  group by r.id, e.report_id, e.r3_obs, e.pa_obs
  having count(v.*) filter (where v.value = -1) < count(v.*) filter (where v.value = 1) + 2
),
news_ev as (
  select n.id, p.lat, p.lng, coalesce(n.observed_at, n.published_at) as t, n.level, n.cause, n.sources
  from public.news_reports n
  cross join lateral (select public.jsonb_num(n.geometry, '{point,0}') as lat, public.jsonb_num(n.geometry, '{point,1}') as lng) p
  where p.lat is not null and p.lng is not null and coalesce(n.observed_at, n.published_at) > now() - interval '730 days'
),
report_tr as (
  select x.*, greatest(x.ecmwf, x.gfs, x.radar, x.r3_obs) as rh,
    case
      when x.enriched and x.r3_obs >= 3 then 'obs_rain'
      when x.enriched and x.pa_obs >= 1.40 then 'obs_tide'
      when exists (
        select 1 from report_ev o
        where o.id <> x.id and o.user_id <> x.user_id
          and abs(extract(epoch from o.observed_at - x.observed_at)) <= 3 * 3600
          and sqrt(power((o.lat - x.lat) * 111320, 2) + power((o.lng - x.lng) * 111320 * cos(radians(x.lat)), 2)) <= 150
      ) or exists (
        select 1 from news_ev n
        where abs(extract(epoch from n.t - x.observed_at)) <= 3 * 3600
          and sqrt(power((n.lat - x.lat) * 111320, 2) + power((n.lng - x.lng) * 111320 * cos(radians(x.lat)), 2)) <= 150
      ) then 'corroborated'
      when not x.enriched and greatest(x.ecmwf, x.gfs, x.radar) >= 3 then 'client_rain'
      when not x.enriched and x.pa >= 1.40 then 'client_tide'
    end as evidence
  from report_ev x
),
events as (
  select lat, lng, jsonb_build_object(
    'id', id, 'source', 'report', 'lat', lat, 'lng', lng, 't', observed_at, 'level', level, 'net', net,
    'Rh', rh,
    'RhSrc', case when rh is null then null when rh = r3_obs then 'obs' when rh = radar then 'radar' when rh = gfs then 'gfs' else 'ecmwf' end,
    'PAh', pa, 'cause', null, 'radarMmH', radar_max,
    'trust', case when evidence in ('obs_rain', 'obs_tide', 'corroborated') then 'trusted'
                  when evidence in ('client_rain', 'client_tide') then 'provisional' else 'untrusted' end,
    'evidence', evidence) as ev
  from report_tr
  union all
  select n.lat, n.lng, jsonb_build_object(
    'id', n.id, 'source', 'news', 'lat', n.lat, 'lng', n.lng, 't', n.t, 'level', n.level,
    'net', null, 'Rh', null, 'RhSrc', null, 'PAh', null, 'cause', n.cause, 'radarMmH', null,
    'trust', 'trusted', 'evidence', 'press',
    'outlet', (select string_agg(distinct s ->> 'outlet', ', ') from jsonb_array_elements(n.sources) s))
  from news_ev n
),
celled as (
  select floor(lat / 0.00135)::bigint as ci, floor(lng / 0.00135)::bigint as cj, ev from events
)
select
  ci || ':' || cj as cell_id,
  round(((ci + 0.5) * 0.00135)::numeric, 6)::double precision as lat,
  round(((cj + 0.5) * 0.00135)::numeric, 6)::double precision as lng,
  jsonb_agg(ev order by ev ->> 't') as events
from celled
group by ci, cj;

grant select on public.flood_cells to anon, authenticated;
