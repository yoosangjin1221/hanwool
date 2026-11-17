-- ════════════════════════════════════════════════════════════════════
-- data10-06 — 팀 저장소(정비 사례 · 설비 목록 · 가이드 수정 · 사진을 팀이 함께 쓰기)
--
-- ▣ 만드는 것: 표 3개 · 함수 1개 · 정책 9개 · 트리거 2개. 이름이 모두 data1006_data_ 로 시작합니다.
--   밖의 개체는 auth.users · auth.uid() 를 참조만 합니다. 트리거는 이 파일이 만든 표에만 붙습니다. storage 를 쓰지 않습니다.
-- ▣ 먼저 auth.sql 을 실행해 두어야 합니다(승인된 구성원만 읽고 쓰게 하는 판정 함수를 씁니다).
-- ▣ 여러 번 실행해도 안전합니다. 이미 있는 자료는 지우지 않습니다.
-- ▣ 실행한 뒤: 사이트에 로그인하면 위쪽 줄이 「팀 저장소 …」로 바뀝니다. 안내는 README.md 13번.
-- ════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.data1006_is_member()') is null or to_regprocedure('public.data1006_is_admin()') is null then
    raise exception '먼저 auth.sql 을 실행해 주세요(data1006_is_member · data1006_is_admin 이 없습니다).';
  end if;
end $$;

-- ───────── 1. 표 ─────────
-- 정비 사례 — 한 건이 한 줄. body 는 화면이 쓰는 사례 모양 그대로(사진은 번호 · 이름만, 그림은 아래 photos 표).
-- 지운 사례는 줄을 없애지 않고 deleted = true 로 남깁니다(다른 사람의 브라우저가 「지워졌다」를 알 수 있게).
create table if not exists public.data1006_data_cases (
  id         text primary key check (char_length(id) between 1 and 80),
  n          bigint generated always as identity,          -- 올린 순서
  body       jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint data1006_data_cases_body check (deleted or body is not null),
  constraint data1006_data_cases_size check (body is null or pg_column_size(body) <= 200000)
);
create index if not exists data1006_data_cases_updated_idx on public.data1006_data_cases (updated_at);

-- 함께 쓰는 설정 — key: equipments(설비 목록) · guides(가이드북 수정) · nextChecks(다음 단계 체크)
create table if not exists public.data1006_data_shared (
  key        text primary key check (key in ('equipments', 'guides', 'nextChecks')),
  body       jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint data1006_data_shared_size check (pg_column_size(body) <= 1000000)
);

-- 사진 — 화면이 줄여 둔 사본(긴 변 1280px JPEG)과 목록용 작은 그림. base64 글자로 넣습니다.
-- 한 번 올린 사진은 고치지 않습니다(돌리면 새 번호로 다시 올림). 그래서 UPDATE 정책이 없습니다.
create table if not exists public.data1006_data_photos (
  id         text primary key check (char_length(id) between 1 and 80),
  case_id    text not null default '',
  name       text not null default '',
  w          int,
  h          int,
  bytes      int,
  img        text not null check (char_length(img) between 1 and 4000000),
  thumb      text not null default '' check (char_length(thumb) <= 400000),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id) on delete set null
);

-- ───────── 2. 고친 시각 · 고친 사람은 서버가 적습니다 ─────────
create or replace function public.data1006_data_stamp()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists data1006_data_cases_stamp on public.data1006_data_cases;
create trigger data1006_data_cases_stamp before insert or update on public.data1006_data_cases
  for each row execute function public.data1006_data_stamp();
drop trigger if exists data1006_data_shared_stamp on public.data1006_data_shared;
create trigger data1006_data_shared_stamp before insert or update on public.data1006_data_shared
  for each row execute function public.data1006_data_stamp();

-- ───────── 3. 접근 정책 — 승인된 구성원만 ─────────
alter table public.data1006_data_cases  enable row level security;
alter table public.data1006_data_shared enable row level security;
alter table public.data1006_data_photos enable row level security;

drop policy if exists data1006_data_cases_read on public.data1006_data_cases;
create policy data1006_data_cases_read on public.data1006_data_cases for select to authenticated
  using (public.data1006_is_member());
drop policy if exists data1006_data_cases_add on public.data1006_data_cases;
create policy data1006_data_cases_add on public.data1006_data_cases for insert to authenticated
  with check (public.data1006_is_member());
drop policy if exists data1006_data_cases_edit on public.data1006_data_cases;
create policy data1006_data_cases_edit on public.data1006_data_cases for update to authenticated
  using (public.data1006_is_member()) with check (public.data1006_is_member());

drop policy if exists data1006_data_shared_read on public.data1006_data_shared;
create policy data1006_data_shared_read on public.data1006_data_shared for select to authenticated
  using (public.data1006_is_member());
drop policy if exists data1006_data_shared_add on public.data1006_data_shared;
create policy data1006_data_shared_add on public.data1006_data_shared for insert to authenticated
  with check (public.data1006_is_member());
drop policy if exists data1006_data_shared_edit on public.data1006_data_shared;
create policy data1006_data_shared_edit on public.data1006_data_shared for update to authenticated
  using (public.data1006_is_member()) with check (public.data1006_is_member());

drop policy if exists data1006_data_photos_read on public.data1006_data_photos;
create policy data1006_data_photos_read on public.data1006_data_photos for select to authenticated
  using (public.data1006_is_member());
drop policy if exists data1006_data_photos_add on public.data1006_data_photos;
create policy data1006_data_photos_add on public.data1006_data_photos for insert to authenticated
  with check (public.data1006_is_member() and created_by = auth.uid());
drop policy if exists data1006_data_photos_del on public.data1006_data_photos;
create policy data1006_data_photos_del on public.data1006_data_photos for delete to authenticated
  using (public.data1006_is_member());

-- ───────── 4. 권한 — 로그인한 사람에게만(정책이 구성원인지 한 번 더 봅니다) ─────────
revoke all on public.data1006_data_cases, public.data1006_data_shared, public.data1006_data_photos from public, anon, authenticated;
grant select on public.data1006_data_cases, public.data1006_data_shared, public.data1006_data_photos to authenticated;
-- 화면은 「있으면 고치고 없으면 넣기」로 보냅니다. 그때 보낸 칸 전부(id · key 포함)에 고치기 권한이 있어야 합니다.
grant insert (id, body, deleted), update (id, body, deleted) on public.data1006_data_cases to authenticated;
grant insert (key, body), update (key, body) on public.data1006_data_shared to authenticated;
grant insert (id, case_id, name, w, h, bytes, img, thumb), delete on public.data1006_data_photos to authenticated;

revoke execute on function public.data1006_data_stamp() from public, anon;
grant execute on function public.data1006_data_stamp() to authenticated;

-- 확인: 표 3 · RLS 3 · 정책 9 · 트리거 2
select
  (select count(*) from pg_tables where schemaname = 'public' and tablename like 'data1006\_data\_%' escape '\')                 as "팀 저장소 표(3)",
  (select count(*) from pg_tables where schemaname = 'public' and tablename like 'data1006\_data\_%' escape '\' and rowsecurity) as "RLS 켜진 표(3)",
  (select count(*) from pg_policies where schemaname = 'public' and tablename like 'data1006\_data\_%' escape '\')               as "정책(9)",
  (select count(*) from pg_trigger g join pg_class c on c.oid = g.tgrelid
     where not g.tgisinternal and c.relname like 'data1006\_data\_%' escape '\')                                                 as "트리거(2)",
  (select count(*) from public.data1006_data_cases where not deleted)                                                            as "사례 수",
  (select count(*) from public.data1006_data_photos)                                                                             as "사진 수";
