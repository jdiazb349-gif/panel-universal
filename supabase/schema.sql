-- =====================================================================
-- Panel Universal · esquema de base de datos (Supabase / Postgres)
-- Ejecutar completo en: Supabase > SQL Editor > New query > Run
-- Es idempotente en lo posible: se puede volver a correr.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Tipos ----------
do $$ begin create type public.app_role as enum ('admin', 'member'); exception when duplicate_object then null; end $$;
do $$ begin create type public.share_permission as enum ('read', 'edit'); exception when duplicate_object then null; end $$;

-- ---------- Tablas ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  full_name    text,
  avatar_url   text,
  role         public.app_role not null default 'member',
  status       text not null default 'active' check (status in ('active', 'suspended')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists public.datasets (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles(id) on delete cascade,
  name         text not null,
  storage_path text not null unique,          -- "<owner_id>/<uuid>-<archivo>"
  columns      jsonb not null default '[]',   -- [{key,type}]
  row_count    integer,
  size_bytes   bigint,
  created_at   timestamptz not null default now()
);

create table if not exists public.dashboards (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  title       text not null default 'Dashboard sin título',
  description text,
  dataset_id  uuid references public.datasets(id) on delete set null,
  config      jsonb not null default '{}',    -- gráficos, filtros, tipos de columna
  is_public   boolean not null default false,
  public_slug text unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.dashboard_members (
  dashboard_id uuid not null references public.dashboards(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  permission   public.share_permission not null default 'read',
  created_at   timestamptz not null default now(),
  primary key (dashboard_id, user_id)
);

create table if not exists public.audit_log (
  id          bigserial primary key,
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text not null,
  target_type text,
  target_id   text,
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

-- Invitaciones: solo los correos invitados (y vigentes) pueden crear cuenta.
create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,            -- siempre en minúsculas
  role        public.app_role not null default 'member',
  invited_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz
);

create index if not exists dashboards_owner_idx on public.dashboards(owner_id);
create index if not exists datasets_owner_idx   on public.datasets(owner_id);
create index if not exists members_user_idx     on public.dashboard_members(user_id);
create index if not exists audit_created_idx    on public.audit_log(created_at desc);

-- ---------- Funciones de permisos (SECURITY DEFINER evita recursión de RLS) ----------
create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active');
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin' and p.status = 'active');
$$;

create or replace function public.can_read_dashboard(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.dashboards x
    where x.id = d and (
      x.is_public
      or (public.is_active() and (
            x.owner_id = auth.uid()
            or exists (select 1 from public.dashboard_members m
                       where m.dashboard_id = x.id and m.user_id = auth.uid()))))
  );
$$;

create or replace function public.can_edit_dashboard(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active() and exists (
    select 1 from public.dashboards x
    where x.id = d and (
      x.owner_id = auth.uid()
      or exists (select 1 from public.dashboard_members m
                 where m.dashboard_id = x.id and m.user_id = auth.uid() and m.permission = 'edit'))
  );
$$;

create or replace function public.is_dashboard_owner(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active() and exists (
    select 1 from public.dashboards x where x.id = d and x.owner_id = auth.uid());
$$;

create or replace function public.can_read_dataset(ds uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.datasets t
    where t.id = ds and (
      (public.is_active() and t.owner_id = auth.uid())
      or exists (select 1 from public.dashboards b
                 where b.dataset_id = t.id and public.can_read_dashboard(b.id)))
  );
$$;

create or replace function public.can_read_dataset_file(path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.datasets t where t.storage_path = path and public.can_read_dataset(t.id));
$$;

-- ---------- Auditoría ----------
create or replace function public.log_action(p_action text, p_type text, p_target text, p_meta jsonb default '{}')
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log(actor_id, action, target_type, target_id, meta)
  values (auth.uid(), p_action, p_type, p_target, coalesce(p_meta, '{}'));
$$;
revoke execute on function public.log_action(text, text, text, jsonb) from public, anon, authenticated;

-- ---------- Triggers ----------
-- Registro SOLO por invitación: bloquea cualquier alta en auth.users sin invitación vigente.
-- Los correos de la lista de administradores iniciales son la única excepción.
create or replace function public.enforce_invitation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if lower(new.email) = any (array['jdiazb349@gmail.com']) then return new; end if;
  if not exists (
    select 1 from public.invitations i
    where i.email = lower(new.email) and i.accepted_at is null and i.expires_at > now()) then
    raise exception 'El registro es solo por invitación';
  end if;
  return new;
end $$;

drop trigger if exists enforce_invitation_trg on auth.users;
create trigger enforce_invitation_trg before insert on auth.users
  for each row execute function public.enforce_invitation();

-- Alta de perfil al registrarse: toma el rol de la invitación y la marca como aceptada.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role public.app_role;
begin
  select i.role into v_role from public.invitations i
   where i.email = lower(new.email) and i.accepted_at is null and i.expires_at > now()
   order by i.created_at desc limit 1;
  if lower(new.email) = any (array['jdiazb349@gmail.com']) then v_role := 'admin'; end if;
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
          coalesce(v_role, 'member'));
  update public.invitations set accepted_at = now() where email = lower(new.email) and accepted_at is null;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Un usuario no puede cambiar su propio rol, estado ni correo (solo SQL directo o RPC de admin).
create or replace function public.protect_profile() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role is distinct from old.role or new.status is distinct from old.status
       or new.email is distinct from old.email or new.id is distinct from old.id then
      raise exception 'No tienes permiso para cambiar rol, estado o correo';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists protect_profile_trg on public.profiles;
create trigger protect_profile_trg before update on public.profiles
  for each row execute function public.protect_profile();

-- Un editor invitado no puede cambiar dueño, publicación ni enlace público.
create or replace function public.protect_dashboard() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if auth.uid() is not null and old.owner_id <> auth.uid() then
    if new.owner_id is distinct from old.owner_id or new.is_public is distinct from old.is_public
       or new.public_slug is distinct from old.public_slug then
      raise exception 'Solo el dueño puede cambiar propietario o publicación';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists protect_dashboard_trg on public.dashboards;
create trigger protect_dashboard_trg before update on public.dashboards
  for each row execute function public.protect_dashboard();

-- ---------- Row Level Security ----------
alter table public.profiles          enable row level security;
alter table public.datasets          enable row level security;
alter table public.dashboards        enable row level security;
alter table public.dashboard_members enable row level security;
alter table public.audit_log         enable row level security;

-- profiles: cada uno ve y edita el suyo (nombre/avatar); admin ve todos.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- datasets: el dueño gestiona; lectura también para quien puede leer un dashboard que lo usa.
drop policy if exists datasets_select on public.datasets;
create policy datasets_select on public.datasets for select to authenticated
  using (public.can_read_dataset(id));
drop policy if exists datasets_insert on public.datasets;
create policy datasets_insert on public.datasets for insert to authenticated
  with check (owner_id = auth.uid() and public.is_active());
drop policy if exists datasets_update on public.datasets;
create policy datasets_update on public.datasets for update to authenticated
  using (owner_id = auth.uid() and public.is_active()) with check (owner_id = auth.uid());
drop policy if exists datasets_delete on public.datasets;
create policy datasets_delete on public.datasets for delete to authenticated
  using (owner_id = auth.uid() and public.is_active());

-- dashboards: dueño o miembros. Los públicos se leen solo por RPC (get_public_dashboard).
drop policy if exists dashboards_select on public.dashboards;
create policy dashboards_select on public.dashboards for select to authenticated
  using (public.is_active() and (owner_id = auth.uid() or exists (
    select 1 from public.dashboard_members m where m.dashboard_id = id and m.user_id = auth.uid())));
drop policy if exists dashboards_insert on public.dashboards;
create policy dashboards_insert on public.dashboards for insert to authenticated
  with check (owner_id = auth.uid() and public.is_active());
drop policy if exists dashboards_update on public.dashboards;
create policy dashboards_update on public.dashboards for update to authenticated
  using (public.can_edit_dashboard(id)) with check (public.can_edit_dashboard(id));
drop policy if exists dashboards_delete on public.dashboards;
create policy dashboards_delete on public.dashboards for delete to authenticated
  using (owner_id = auth.uid() and public.is_active());

-- dashboard_members: el dueño administra; cada miembro ve su propia fila.
drop policy if exists members_select on public.dashboard_members;
create policy members_select on public.dashboard_members for select to authenticated
  using (user_id = auth.uid() or public.is_dashboard_owner(dashboard_id));
drop policy if exists members_insert on public.dashboard_members;
create policy members_insert on public.dashboard_members for insert to authenticated
  with check (public.is_dashboard_owner(dashboard_id));
drop policy if exists members_update on public.dashboard_members;
create policy members_update on public.dashboard_members for update to authenticated
  using (public.is_dashboard_owner(dashboard_id)) with check (public.is_dashboard_owner(dashboard_id));
drop policy if exists members_delete on public.dashboard_members;
create policy members_delete on public.dashboard_members for delete to authenticated
  using (public.is_dashboard_owner(dashboard_id) or user_id = auth.uid());

-- invitations: solo administradores; se gestionan con admin_invite / admin_revoke_invitation.
alter table public.invitations enable row level security;
drop policy if exists invitations_select on public.invitations;
create policy invitations_select on public.invitations for select to authenticated using (public.is_admin());

-- audit_log: solo admins leen; nadie escribe directo (lo hacen las funciones).
drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log for select to authenticated using (public.is_admin());

-- ---------- RPC: compartir y publicar ----------
create or replace function public.share_dashboard(p_dashboard uuid, p_email text, p_permission public.share_permission)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user public.profiles;
begin
  if not public.is_dashboard_owner(p_dashboard) then raise exception 'Solo el dueño puede compartir'; end if;
  select * into v_user from public.profiles
   where lower(email) = lower(trim(p_email)) and status = 'active';
  if not found then raise exception 'No existe un usuario activo con ese correo'; end if;
  if v_user.id = auth.uid() then raise exception 'Ya eres el dueño'; end if;
  insert into public.dashboard_members(dashboard_id, user_id, permission)
  values (p_dashboard, v_user.id, p_permission)
  on conflict (dashboard_id, user_id) do update set permission = excluded.permission;
  perform public.log_action('dashboard.share', 'dashboard', p_dashboard::text,
          jsonb_build_object('user', v_user.id, 'permission', p_permission));
  return jsonb_build_object('user_id', v_user.id, 'full_name', v_user.full_name, 'email', v_user.email);
end $$;

create or replace function public.list_dashboard_members(p_dashboard uuid)
returns table (user_id uuid, full_name text, email text, permission public.share_permission)
language sql stable security definer set search_path = public as $$
  select m.user_id, p.full_name, p.email, m.permission
  from public.dashboard_members m join public.profiles p on p.id = m.user_id
  where m.dashboard_id = p_dashboard and public.is_dashboard_owner(p_dashboard);
$$;

create or replace function public.set_dashboard_public(p_dashboard uuid, p_public boolean)
returns text language plpgsql security definer set search_path = public as $$
declare v_slug text;
begin
  if not public.is_dashboard_owner(p_dashboard) then raise exception 'Solo el dueño puede publicar'; end if;
  if p_public then
    select public_slug into v_slug from public.dashboards where id = p_dashboard;
    if v_slug is null then v_slug := encode(gen_random_bytes(9), 'hex'); end if;
    update public.dashboards set is_public = true, public_slug = v_slug where id = p_dashboard;
  else
    update public.dashboards set is_public = false where id = p_dashboard;
    v_slug := null;
  end if;
  perform public.log_action(case when p_public then 'dashboard.publish' else 'dashboard.unpublish' end,
                            'dashboard', p_dashboard::text, '{}');
  return v_slug;
end $$;

-- Lectura anónima de un dashboard público, solo conociendo su enlace.
create or replace function public.get_public_dashboard(p_slug text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', d.id, 'title', d.title, 'description', d.description, 'config', d.config,
    'dataset', case when t.id is null then null
                    else jsonb_build_object('id', t.id, 'name', t.name, 'storage_path', t.storage_path, 'columns', t.columns) end,
    'updated_at', d.updated_at)
  from public.dashboards d left join public.datasets t on t.id = d.dataset_id
  where d.public_slug = p_slug and d.is_public;
$$;

-- ---------- RPC: administración ----------
create or replace function public.admin_overview()
returns table (id uuid, email text, full_name text, role public.app_role, status text,
               created_at timestamptz, last_seen_at timestamptz, dashboards bigint, datasets bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.full_name, p.role, p.status, p.created_at, p.last_seen_at,
         (select count(*) from public.dashboards d where d.owner_id = p.id),
         (select count(*) from public.datasets t where t.owner_id = p.id)
  from public.profiles p
  where public.is_admin()
  order by p.created_at desc;
$$;

create or replace function public.admin_set_role(p_user uuid, p_role public.app_role)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Solo administradores'; end if;
  if p_role <> 'admin' and (select count(*) from public.profiles where role = 'admin' and status = 'active' and id <> p_user) = 0 then
    raise exception 'Debe quedar al menos un administrador activo';
  end if;
  update public.profiles set role = p_role where id = p_user;
  perform public.log_action('user.set_role', 'user', p_user::text, jsonb_build_object('role', p_role));
end $$;

create or replace function public.admin_set_status(p_user uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Solo administradores'; end if;
  if p_status not in ('active', 'suspended') then raise exception 'Estado inválido'; end if;
  if p_status = 'suspended' and (
       p_user = auth.uid() or (select role from public.profiles where id = p_user) = 'admin'
       and (select count(*) from public.profiles where role = 'admin' and status = 'active' and id <> p_user) = 0) then
    raise exception 'No puedes suspender a este usuario';
  end if;
  update public.profiles set status = p_status where id = p_user;
  perform public.log_action('user.set_status', 'user', p_user::text, jsonb_build_object('status', p_status));
end $$;

create or replace function public.admin_invite(p_email text, p_role public.app_role default 'member')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email)); v_id uuid;
begin
  if not public.is_admin() then raise exception 'Solo administradores'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo inválido'; end if;
  if exists (select 1 from public.profiles where lower(email) = v_email) then
    raise exception 'Ese correo ya tiene una cuenta';
  end if;
  insert into public.invitations (email, role, invited_by)
  values (v_email, p_role, auth.uid())
  on conflict (email) do update
    set role = excluded.role, invited_by = excluded.invited_by,
        created_at = now(), expires_at = now() + interval '14 days', accepted_at = null
  returning id into v_id;
  perform public.log_action('user.invite', 'invitation', v_id::text,
          jsonb_build_object('email', v_email, 'role', p_role));
  return v_id;
end $$;

create or replace function public.admin_revoke_invitation(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Solo administradores'; end if;
  delete from public.invitations where id = p_id and accepted_at is null;
  perform public.log_action('user.invite_revoke', 'invitation', p_id::text, '{}');
end $$;

create or replace function public.touch_last_seen() returns void
language sql security definer set search_path = public as $$
  update public.profiles set last_seen_at = now() where id = auth.uid();
$$;

-- Permisos de ejecución
revoke execute on all functions in schema public from public, anon;
grant execute on function public.get_public_dashboard(text) to anon, authenticated;
grant execute on function public.can_read_dataset_file(text) to anon, authenticated;
grant execute on function public.can_read_dashboard(uuid), public.can_read_dataset(uuid), public.is_active() to anon, authenticated;
grant execute on function public.is_active(), public.is_admin(), public.can_edit_dashboard(uuid),
      public.is_dashboard_owner(uuid), public.share_dashboard(uuid, text, public.share_permission),
      public.list_dashboard_members(uuid), public.set_dashboard_public(uuid, boolean),
      public.admin_overview(), public.admin_set_role(uuid, public.app_role),
      public.admin_set_status(uuid, text), public.touch_last_seen(),
      public.admin_invite(text, public.app_role), public.admin_revoke_invitation(uuid) to authenticated;
revoke execute on function public.log_action(text, text, text, jsonb) from authenticated;

-- ---------- Storage: bucket privado "datasets" (máx. 25 MB por archivo) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('datasets', 'datasets', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

drop policy if exists datasets_obj_insert on storage.objects;
create policy datasets_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active());
drop policy if exists datasets_obj_select on storage.objects;
create policy datasets_obj_select on storage.objects for select to anon, authenticated
  using (bucket_id = 'datasets' and (
    ((storage.foldername(name))[1] = auth.uid()::text and public.is_active())
    or public.can_read_dataset_file(name)));
drop policy if exists datasets_obj_update on storage.objects;
create policy datasets_obj_update on storage.objects for update to authenticated
  using (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active());
drop policy if exists datasets_obj_delete on storage.objects;
create policy datasets_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active());

-- ---------- Asistente de IA: registro de uso para limitar solicitudes por usuario ----------
-- Solo la función "chat" (service role) lee y escribe aquí; sin políticas = ningún usuario accede directo.
create table if not exists public.ai_usage (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_user_time_idx on public.ai_usage(user_id, created_at desc);
alter table public.ai_usage enable row level security;
