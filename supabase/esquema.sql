-- =====================================================================
--  FAMILIA EMETRA · CONTROL DE ASISTENCIA
--  Ejecuta TODO este archivo una sola vez en:
--  Supabase → SQL Editor → New query → pegar → Run
--
--  PIN inicial del administrador: 0000  (cámbialo en Ajustes al entrar)
-- =====================================================================

-- ---------- TABLAS ----------
create table if not exists config (
  id          int primary key default 1 check (id = 1),
  admin_pin   text not null,
  timeout_min int  not null default 30
);
insert into config (id, admin_pin) values (1, '0000') on conflict (id) do nothing;

create table if not exists personas (
  id      bigserial primary key,
  nombre  text not null,
  clave   text not null unique,          -- nombre normalizado (sin tildes, minúsculas, solo letras)
  area    text not null default 'Sin área',
  creado  timestamptz not null default now()
);

create table if not exists galardonados (
  clave   text primary key,
  nombre  text not null,
  creado  timestamptz not null default now()
);

create table if not exists encargados (
  id      bigserial primary key,
  nombre  text not null,
  clave   text not null unique,
  pin     text not null unique check (pin ~ '^[0-9]{4}$'),
  activo  boolean not null default true,
  creado  timestamptz not null default now()
);

create table if not exists sesiones (
  token        uuid primary key default gen_random_uuid(),
  encargado_id bigint references encargados(id) on delete cascade,
  es_admin     boolean not null default false,
  nombre       text not null,
  inicio       timestamptz not null default now(),
  ultimo       timestamptz not null default now()
);

create table if not exists asistencia (
  persona_id     bigint primary key references personas(id) on delete cascade,
  encargado_id   bigint references encargados(id) on delete set null,
  registrado_por text not null,
  fecha          timestamptz not null default now()
);

create table if not exists historial (
  id       bigserial primary key,
  fecha    timestamptz not null default now(),
  usuario  text,
  accion   text not null,
  detalle  text
);
create index if not exists historial_fecha_idx on historial (fecha desc);

-- Nadie entra a las tablas directamente: todo pasa por las funciones de abajo.
alter table config       enable row level security;
alter table personas     enable row level security;
alter table galardonados enable row level security;
alter table encargados   enable row level security;
alter table sesiones     enable row level security;
alter table asistencia   enable row level security;
alter table historial    enable row level security;

-- ---------- UTILIDADES INTERNAS ----------
create or replace function norm(t text) returns text
language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(lower(translate(coalesce(t, ''),
    'áàäâãåéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
    'aaaaaaeeeeiiiiooooouuuuncAAAAAAEEEEIIIIOOOOOUUUUNC')),
    '[^a-z ]', '', 'g'), '\s+', ' ', 'g'))
$$;

create or replace function limpiar(t text) returns text
language sql immutable as $$
  select btrim(regexp_replace(coalesce(t, ''), '\s+', ' ', 'g'))
$$;

create or replace function _log(p_usuario text, p_accion text, p_detalle text) returns void
language sql security definer set search_path = public as $$
  insert into historial (usuario, accion, detalle) values (p_usuario, p_accion, p_detalle);
$$;

create or replace function _sesion(p_token uuid, p_tocar boolean default true) returns sesiones
language plpgsql security definer set search_path = public as $$
declare s sesiones; v_t int;
begin
  select timeout_min into v_t from config where id = 1;
  select * into s from sesiones where token = p_token;
  if not found or s.ultimo < now() - make_interval(mins => v_t) then
    raise exception 'SESION_EXPIRADA';
  end if;
  if not s.es_admin and not exists (select 1 from encargados where id = s.encargado_id and activo) then
    raise exception 'SESION_EXPIRADA';
  end if;
  if p_tocar then
    update sesiones set ultimo = now() where token = p_token;
  end if;
  return s;
end $$;

create or replace function _admin(p_token uuid) returns sesiones
language plpgsql security definer set search_path = public as $$
declare s sesiones;
begin
  s := _sesion(p_token);
  if not s.es_admin then raise exception 'NO_AUTORIZADO'; end if;
  return s;
end $$;

-- ---------- SESIÓN ----------
create or replace function iniciar_sesion(p_nombre text, p_pin text) returns json
language plpgsql security definer set search_path = public as $$
declare
  c config; e encargados; v_tok uuid;
  v_clave text := norm(p_nombre);
begin
  select * into c from config where id = 1;
  if v_clave = '' or coalesce(p_pin, '') = '' then
    return json_build_object('ok', false, 'error', 'DATOS_INCOMPLETOS');
  end if;

  -- Bloqueo: 5 intentos fallidos en 10 minutos para ese nombre
  if (select count(*) from historial
       where accion = 'Intento de ingreso fallido' and norm(usuario) = v_clave
         and fecha > now() - interval '10 minutes') >= 5 then
    return json_build_object('ok', false, 'error', 'BLOQUEADO');
  end if;

  if v_clave = 'administrador' then
    if p_pin is distinct from c.admin_pin then
      perform pg_sleep(1);
      perform _log('Administrador', 'Intento de ingreso fallido', 'PIN incorrecto');
      return json_build_object('ok', false, 'error', 'CREDENCIALES');
    end if;
    insert into sesiones (es_admin, nombre) values (true, 'Administrador') returning token into v_tok;
    perform _log('Administrador', 'Inició sesión', null);
    return json_build_object('ok', true, 'token', v_tok, 'rol', 'admin', 'nombre', 'Administrador');
  end if;

  select * into e from encargados where clave = v_clave and pin = p_pin;
  if not found then
    perform pg_sleep(1);
    perform _log(limpiar(p_nombre), 'Intento de ingreso fallido', 'Nombre o PIN incorrecto');
    return json_build_object('ok', false, 'error', 'CREDENCIALES');
  end if;
  if not e.activo then
    return json_build_object('ok', false, 'error', 'DESACTIVADO');
  end if;
  if exists (select 1 from sesiones where encargado_id = e.id
               and ultimo >= now() - make_interval(mins => c.timeout_min)) then
    perform _log(e.nombre, 'Intento de ingreso bloqueado', 'Ya tenía una sesión abierta en otro dispositivo');
    return json_build_object('ok', false, 'error', 'SESION_EN_USO');
  end if;

  delete from sesiones where encargado_id = e.id;
  insert into sesiones (encargado_id, nombre) values (e.id, e.nombre) returning token into v_tok;
  perform _log(e.nombre, 'Inició sesión', null);
  return json_build_object('ok', true, 'token', v_tok, 'rol', 'encargado', 'nombre', e.nombre);
end $$;

create or replace function cerrar_sesion(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones;
begin
  delete from sesiones where token = p_token returning * into s;
  if found then perform _log(s.nombre, 'Cerró sesión', null); end if;
  return json_build_object('ok', true);
end $$;

-- ---------- ASISTENCIA ----------
create or replace function listar_personas(p_token uuid, p_activo boolean default false) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones;
begin
  s := _sesion(p_token, p_activo);
  return json_build_object(
    'rol', case when s.es_admin then 'admin' else 'encargado' end,
    'nombre', s.nombre,
    'timeout', (select timeout_min from config where id = 1),
    'personas', coalesce((
      select json_agg(json_build_object(
               'id', p.id, 'n', p.nombre, 'a', p.area,
               'g', g.clave is not null,
               'por', a.registrado_por,
               'mio', coalesce(a.encargado_id = s.encargado_id, false),
               'f', a.fecha) order by p.clave)
      from personas p
      left join galardonados g on g.clave = p.clave
      left join asistencia  a on a.persona_id = p.id), '[]'::json));
end $$;

create or replace function marcar_asistencia(p_token uuid, p_ids bigint[]) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; r record; v_n int := 0; v_ya int := 0;
begin
  s := _sesion(p_token);
  if s.es_admin then raise exception 'SOLO_ENCARGADOS'; end if;
  for r in select id, nombre from personas where id = any(p_ids) order by clave loop
    insert into asistencia (persona_id, encargado_id, registrado_por)
      values (r.id, s.encargado_id, s.nombre)
      on conflict (persona_id) do nothing;
    if found then
      v_n := v_n + 1;
      perform _log(s.nombre, 'Marcó asistencia', r.nombre);
    else
      v_ya := v_ya + 1;
    end if;
  end loop;
  return json_build_object('marcados', v_n, 'ya_marcados', v_ya);
end $$;

create or replace function quitar_asistencia(p_token uuid, p_persona_id bigint) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; a asistencia; v_nombre text;
begin
  s := _sesion(p_token);
  select * into a from asistencia where persona_id = p_persona_id;
  if not found then raise exception 'NO_MARCADO'; end if;
  if not s.es_admin and a.encargado_id is distinct from s.encargado_id then
    raise exception 'NO_PERMITIDO';
  end if;
  select nombre into v_nombre from personas where id = p_persona_id;
  delete from asistencia where persona_id = p_persona_id;
  perform _log(s.nombre, 'Quitó asistencia',
    v_nombre || case when s.es_admin then ' (registrada por ' || a.registrado_por || ')' else '' end);
  return json_build_object('ok', true);
end $$;

-- ---------- ADMINISTRADOR: LISTAS ----------
create or replace function subir_personas(p_token uuid, p_filas json, p_archivo text default null) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; f json; v_nom text; v_area text; v_n int := 0; v_e int := 0; v_v int := 0;
begin
  s := _admin(p_token);
  for f in select * from json_array_elements(p_filas) loop
    v_nom  := limpiar(f->>'nombre');
    v_area := nullif(limpiar(f->>'area'), '');
    if norm(v_nom) = '' then v_v := v_v + 1; continue; end if;
    insert into personas (nombre, clave, area)
      values (v_nom, norm(v_nom), coalesce(v_area, 'Sin área'))
      on conflict (clave) do nothing;
    if found then
      v_n := v_n + 1;
    else
      v_e := v_e + 1;
      if v_area is not null then
        update personas set area = v_area where clave = norm(v_nom) and area = 'Sin área';
      end if;
    end if;
  end loop;
  perform _log(s.nombre, 'Subió lista de personas',
    format('%s%s nuevas, %s ya existían', coalesce(p_archivo || ': ', ''), v_n, v_e));
  return json_build_object('nuevos', v_n, 'existentes', v_e, 'vacios', v_v);
end $$;

create or replace function subir_galardonados(p_token uuid, p_filas json, p_archivo text default null) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; f json; v_nom text; v_n int := 0; v_e int := 0; v_sin int;
begin
  s := _admin(p_token);
  for f in select * from json_array_elements(p_filas) loop
    v_nom := limpiar(f->>'nombre');
    if norm(v_nom) = '' then continue; end if;
    insert into galardonados (clave, nombre) values (norm(v_nom), v_nom) on conflict (clave) do nothing;
    if found then v_n := v_n + 1; else v_e := v_e + 1; end if;
  end loop;
  select count(*) into v_sin from galardonados g where not exists (select 1 from personas p where p.clave = g.clave);
  perform _log(s.nombre, 'Subió lista de galardonados',
    format('%s%s nuevos, %s ya existían', coalesce(p_archivo || ': ', ''), v_n, v_e));
  return json_build_object('nuevos', v_n, 'existentes', v_e, 'sin_lista', v_sin);
end $$;

create or replace function quitar_galardonado(p_token uuid, p_nombre text) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; g galardonados;
begin
  s := _admin(p_token);
  delete from galardonados where clave = norm(p_nombre) returning * into g;
  if found then perform _log(s.nombre, 'Quitó galardonado', g.nombre); end if;
  return json_build_object('ok', found);
end $$;

create or replace function galardonados_sin_lista(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones;
begin
  s := _admin(p_token);
  return coalesce((select json_agg(g.nombre order by g.clave) from galardonados g
    where not exists (select 1 from personas p where p.clave = g.clave)), '[]'::json);
end $$;

-- ---------- ADMINISTRADOR: ENCARGADOS ----------
create or replace function encargados_listar(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; v_t int;
begin
  s := _admin(p_token);
  select timeout_min into v_t from config where id = 1;
  return coalesce((
    select json_agg(json_build_object(
      'id', e.id, 'nombre', e.nombre, 'pin', e.pin, 'activo', e.activo,
      'en_sesion', exists (select 1 from sesiones x where x.encargado_id = e.id
                            and x.ultimo >= now() - make_interval(mins => v_t)),
      'marcados', (select count(*) from asistencia a where a.encargado_id = e.id)
    ) order by e.nombre)
    from encargados e), '[]'::json);
end $$;

create or replace function encargado_guardar(p_token uuid, p_id bigint, p_nombre text, p_pin text, p_activo boolean default true) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; v_nom text := limpiar(p_nombre); v_clave text := norm(p_nombre); v_id bigint;
begin
  s := _admin(p_token);
  if v_clave = '' or position(' ' in v_clave) = 0 then raise exception 'NOMBRE_APELLIDO'; end if;
  if v_clave = 'administrador' then raise exception 'NOMBRE_RESERVADO'; end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then raise exception 'PIN_INVALIDO'; end if;
  if p_pin = (select admin_pin from config where id = 1)
     or exists (select 1 from encargados where pin = p_pin and id is distinct from p_id) then
    raise exception 'PIN_EN_USO';
  end if;
  if exists (select 1 from encargados where clave = v_clave and id is distinct from p_id) then
    raise exception 'NOMBRE_EN_USO';
  end if;

  if p_id is null then
    if (select count(*) from encargados) >= 15 then raise exception 'LIMITE_15'; end if;
    insert into encargados (nombre, clave, pin) values (v_nom, v_clave, p_pin) returning id into v_id;
    perform _log(s.nombre, 'Creó encargado', v_nom);
  else
    update encargados set nombre = v_nom, clave = v_clave, pin = p_pin, activo = coalesce(p_activo, true)
      where id = p_id returning id into v_id;
    if v_id is null then raise exception 'NO_EXISTE'; end if;
    delete from sesiones where encargado_id = p_id;
    perform _log(s.nombre, 'Editó encargado',
      v_nom || case when coalesce(p_activo, true) then '' else ' (desactivado)' end);
  end if;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function liberar_sesion(p_token uuid, p_encargado_id bigint) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; v_nom text;
begin
  s := _admin(p_token);
  select nombre into v_nom from encargados where id = p_encargado_id;
  delete from sesiones where encargado_id = p_encargado_id;
  perform _log(s.nombre, 'Liberó la sesión de', v_nom);
  return json_build_object('ok', true);
end $$;

-- ---------- ADMINISTRADOR: HISTORIAL, EXCEL Y AJUSTES ----------
create or replace function ver_historial(p_token uuid, p_limite int default 300) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones;
begin
  s := _admin(p_token);
  return coalesce((
    select json_agg(json_build_object('f', h.fecha, 'u', h.usuario, 'a', h.accion, 'd', h.detalle) order by h.id desc)
    from (select * from historial order by id desc limit least(greatest(p_limite, 1), 5000)) h), '[]'::json);
end $$;

create or replace function exportar(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones;
begin
  s := _admin(p_token);
  perform _log(s.nombre, 'Descargó el Excel', null);
  return json_build_object(
    'personas', coalesce((
      select json_agg(json_build_object(
        'n', p.nombre, 'a', p.area, 'g', g.clave is not null,
        'por', a.registrado_por, 'f', a.fecha) order by p.area, p.clave)
      from personas p
      left join galardonados g on g.clave = p.clave
      left join asistencia  a on a.persona_id = p.id), '[]'::json),
    'galardonados_sin_lista', coalesce((
      select json_agg(g.nombre order by g.clave) from galardonados g
      where not exists (select 1 from personas p where p.clave = g.clave)), '[]'::json),
    'historial', coalesce((
      select json_agg(json_build_object('f', h.fecha, 'u', h.usuario, 'a', h.accion, 'd', h.detalle) order by h.id)
      from historial h), '[]'::json));
end $$;

create or replace function guardar_config(p_token uuid, p_admin_pin text, p_timeout int) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones;
begin
  s := _admin(p_token);
  if p_admin_pin is not null and p_admin_pin <> '' then
    if p_admin_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN_ADMIN_INVALIDO'; end if;
    if exists (select 1 from encargados where pin = p_admin_pin) then raise exception 'PIN_EN_USO'; end if;
    update config set admin_pin = p_admin_pin where id = 1;
    perform _log(s.nombre, 'Cambió el PIN de administrador', null);
  end if;
  if p_timeout is not null then
    if p_timeout < 5 or p_timeout > 240 then raise exception 'TIEMPO_INVALIDO'; end if;
    update config set timeout_min = p_timeout where id = 1;
    perform _log(s.nombre, 'Cambió el tiempo de inactividad', p_timeout || ' minutos');
  end if;
  return json_build_object('ok', true);
end $$;

-- ---------- PERMISOS ----------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  iniciar_sesion(text, text),
  cerrar_sesion(uuid),
  listar_personas(uuid, boolean),
  marcar_asistencia(uuid, bigint[]),
  quitar_asistencia(uuid, bigint),
  subir_personas(uuid, json, text),
  subir_galardonados(uuid, json, text),
  quitar_galardonado(uuid, text),
  galardonados_sin_lista(uuid),
  encargados_listar(uuid),
  encargado_guardar(uuid, bigint, text, text, boolean),
  liberar_sesion(uuid, bigint),
  ver_historial(uuid, int),
  exportar(uuid),
  guardar_config(uuid, text, int)
to anon;

notify pgrst, 'reload schema';
