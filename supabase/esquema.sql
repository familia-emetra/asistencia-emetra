-- =====================================================================
--  FAMILIA EMETRA · CONTROL DE ASISTENCIA  (versión 2)
--  Supabase → SQL Editor → New query → pegar TODO → Run
--
--  Se puede ejecutar en un proyecto nuevo o encima de la versión 1:
--  no borra datos, encargados ni el PIN del administrador.
--  PIN inicial del administrador (solo en proyecto nuevo): 0000
-- =====================================================================

-- ---------- TABLAS ----------
create table if not exists config (
  id          int primary key default 1 check (id = 1),
  admin_pin   text not null,
  timeout_min int  not null default 30
);
insert into config (id, admin_pin) values (1, '0000') on conflict (id) do nothing;

create table if not exists personas (            -- NÓMINA
  id      bigserial primary key,
  nombre  text not null,
  clave   text not null unique,
  area    text not null default 'Sin área',
  creado  timestamptz not null default now()
);

create table if not exists galardonados (
  clave   text primary key,
  nombre  text not null,
  creado  timestamptz not null default now()
);

create table if not exists inscritos (            -- CONFIRMADOS (lista de inscripción)
  id         bigserial primary key,
  nombre     text not null,
  clave      text not null unique,
  persona_id bigint references personas(id) on delete set null,
  estado     text not null default 'pendiente'
             check (estado in ('auto', 'manual', 'pendiente', 'no_nomina')),
  creado     timestamptz not null default now()
);
create index if not exists inscritos_persona_idx on inscritos (persona_id);

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
alter table asistencia add column if not exists familiares int not null default 0;

create table if not exists historial (
  id       bigserial primary key,
  fecha    timestamptz not null default now(),
  usuario  text,
  accion   text not null,
  detalle  text
);
create index if not exists historial_fecha_idx on historial (fecha desc);

alter table config       enable row level security;
alter table personas     enable row level security;
alter table galardonados enable row level security;
alter table inscritos    enable row level security;
alter table encargados   enable row level security;
alter table sesiones     enable row level security;
alter table asistencia   enable row level security;
alter table historial    enable row level security;

-- Funciones de la versión 1 que cambiaron de forma
drop function if exists marcar_asistencia(uuid, bigint[]);

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

create or replace function _confirmo(p_persona_id bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from inscritos where persona_id = p_persona_id and estado in ('auto', 'manual'));
$$;

-- Busca en la nómina a quién corresponde un nombre inscrito.
-- Devuelve el id solo si hay UNA coincidencia segura; si no, null (queda "por revisar").
create or replace function _emparejar(p_clave text) returns bigint
language plpgsql stable security definer set search_path = public as $$
declare v_w text[] := string_to_array(p_clave, ' '); v_id bigint; v_n int;
begin
  select id into v_id from personas where clave = p_clave;
  if found then return v_id; end if;
  if coalesce(array_length(v_w, 1), 0) < 2 then return null; end if;
  select count(*), min(id) into v_n, v_id from personas p
   where string_to_array(p.clave, ' ') @> v_w
      or (array_length(string_to_array(p.clave, ' '), 1) >= 2 and v_w @> string_to_array(p.clave, ' '));
  if v_n = 1 then return v_id; end if;
  return null;
end $$;

create or replace function _reemparejar() returns int
language plpgsql security definer set search_path = public as $$
declare r record; v bigint; n int := 0;
begin
  for r in select id, clave from inscritos where estado = 'pendiente' loop
    v := _emparejar(r.clave);
    if v is not null then
      update inscritos set persona_id = v, estado = 'auto' where id = r.id;
      n := n + 1;
    end if;
  end loop;
  return n;
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
    'pendientes', case when s.es_admin then (select count(*) from inscritos where estado = 'pendiente') else 0 end,
    'personas', coalesce((
      select json_agg(json_build_object(
               'id', p.id, 'n', p.nombre, 'a', p.area,
               'g', g.clave is not null,
               'c', p.id in (select persona_id from inscritos where estado in ('auto', 'manual') and persona_id is not null),
               'por', a.registrado_por,
               'mio', coalesce(a.encargado_id = s.encargado_id, false),
               'fam', a.familiares,
               'f', a.fecha) order by p.clave)
      from personas p
      left join galardonados g on g.clave = p.clave
      left join asistencia  a on a.persona_id = p.id), '[]'::json));
end $$;

create or replace function marcar_asistencia(p_token uuid, p_persona_id bigint, p_familiares int default 0) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; v_nom text; v_por text; v_fam int := coalesce(p_familiares, 0);
begin
  s := _sesion(p_token);
  if s.es_admin then raise exception 'SOLO_ENCARGADOS'; end if;
  if v_fam < 0 or v_fam > 200 then raise exception 'FAMILIARES_INVALIDO'; end if;
  select nombre into v_nom from personas where id = p_persona_id;
  if not found then raise exception 'NO_EXISTE'; end if;

  insert into asistencia (persona_id, encargado_id, registrado_por, familiares)
    values (p_persona_id, s.encargado_id, s.nombre, v_fam)
    on conflict (persona_id) do nothing;
  if not found then
    select registrado_por into v_por from asistencia where persona_id = p_persona_id;
    return json_build_object('ok', false, 'por', v_por);
  end if;

  perform _log(s.nombre, 'Marcó asistencia',
    v_nom || ' · ' || v_fam || case when v_fam = 1 then ' familiar' else ' familiares' end
    || case when _confirmo(p_persona_id) then '' else ' · no había confirmado' end);
  return json_build_object('ok', true);
end $$;

create or replace function cambiar_familiares(p_token uuid, p_persona_id bigint, p_familiares int) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; a asistencia; v_nom text;
begin
  s := _sesion(p_token);
  if p_familiares is null or p_familiares < 0 or p_familiares > 200 then raise exception 'FAMILIARES_INVALIDO'; end if;
  select * into a from asistencia where persona_id = p_persona_id;
  if not found then raise exception 'NO_MARCADO'; end if;
  if not s.es_admin and a.encargado_id is distinct from s.encargado_id then raise exception 'NO_PERMITIDO'; end if;
  if a.familiares = p_familiares then return json_build_object('ok', true); end if;
  select nombre into v_nom from personas where id = p_persona_id;
  update asistencia set familiares = p_familiares where persona_id = p_persona_id;
  perform _log(s.nombre, 'Cambió familiares', format('%s: de %s a %s', v_nom, a.familiares, p_familiares));
  return json_build_object('ok', true);
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
    v_nombre || ' (tenía ' || a.familiares || ' familiares)'
    || case when s.es_admin then ' · registrada por ' || a.registrado_por else '' end);
  return json_build_object('ok', true);
end $$;

-- ---------- ADMINISTRADOR: LISTAS ----------
create or replace function subir_personas(p_token uuid, p_filas json, p_archivo text default null) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; f json; v_nom text; v_area text; v_n int := 0; v_e int := 0; v_v int := 0; v_cruz int;
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
  v_cruz := _reemparejar();
  perform _log(s.nombre, 'Subió nómina',
    format('%s%s nuevas, %s ya existían', coalesce(p_archivo || ': ', ''), v_n, v_e)
    || case when v_cruz > 0 then format(', %s confirmados se cruzaron', v_cruz) else '' end);
  return json_build_object('nuevos', v_n, 'existentes', v_e, 'vacios', v_v, 'cruzados', v_cruz);
end $$;

create or replace function subir_confirmados(p_token uuid, p_filas json, p_archivo text default null) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; f json; v_nom text; v_clave text; v_id bigint; v_p bigint;
        v_n int := 0; v_e int := 0; v_auto int := 0; v_pend int := 0;
begin
  s := _admin(p_token);
  for f in select * from json_array_elements(p_filas) loop
    v_nom := limpiar(f->>'nombre'); v_clave := norm(v_nom);
    if v_clave = '' then continue; end if;
    v_id := null;
    insert into inscritos (nombre, clave) values (v_nom, v_clave)
      on conflict (clave) do nothing returning id into v_id;
    if v_id is null then v_e := v_e + 1; continue; end if;
    v_n := v_n + 1;
    v_p := _emparejar(v_clave);
    if v_p is not null then
      update inscritos set persona_id = v_p, estado = 'auto' where id = v_id;
      v_auto := v_auto + 1;
    else
      v_pend := v_pend + 1;
    end if;
  end loop;
  perform _log(s.nombre, 'Subió lista de confirmados',
    format('%s%s nuevos (%s cruzados, %s por revisar), %s ya existían',
           coalesce(p_archivo || ': ', ''), v_n, v_auto, v_pend, v_e));
  return json_build_object('nuevos', v_n, 'existentes', v_e, 'cruzados', v_auto, 'pendientes', v_pend);
end $$;

create or replace function inscritos_revisar(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones;
begin
  s := _admin(p_token);
  return json_build_object(
    'pendientes', coalesce((
      select json_agg(json_build_object('id', i.id, 'n', i.nombre, 'cand', coalesce((
        select json_agg(json_build_object('id', t.id, 'n', t.nombre, 'a', t.area))
        from (select c.* from (select p.id, p.nombre, p.area,
                (select count(*) from unnest(string_to_array(p.clave, ' ')) w
                  where length(w) > 2 and w = any(string_to_array(i.clave, ' '))) as comunes
              from personas p) c
              where c.comunes >= 1
              order by c.comunes desc, c.nombre
              limit 6) t), '[]'::json)) order by i.nombre)
      from inscritos i where i.estado = 'pendiente'), '[]'::json),
    'resueltos', coalesce((
      select json_agg(json_build_object('id', i.id, 'n', i.nombre, 'e', i.estado, 'p', p.nombre, 'a', p.area) order by i.nombre)
      from inscritos i left join personas p on p.id = i.persona_id
      where i.estado in ('manual', 'no_nomina')), '[]'::json));
end $$;

create or replace function inscrito_resolver(p_token uuid, p_id bigint, p_accion text, p_persona_id bigint default null) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; i inscritos; v_p text;
begin
  s := _admin(p_token);
  select * into i from inscritos where id = p_id;
  if not found then raise exception 'NO_EXISTE'; end if;
  if p_accion = 'asignar' then
    select nombre into v_p from personas where id = p_persona_id;
    if v_p is null then raise exception 'NO_EXISTE'; end if;
    update inscritos set persona_id = p_persona_id, estado = 'manual' where id = p_id;
    perform _log(s.nombre, 'Cruzó confirmado a mano', format('"%s" → %s', i.nombre, v_p));
  elsif p_accion = 'no_nomina' then
    update inscritos set persona_id = null, estado = 'no_nomina' where id = p_id;
    perform _log(s.nombre, 'Marcó confirmado como no está en nómina', i.nombre);
  elsif p_accion = 'reabrir' then
    update inscritos set persona_id = null, estado = 'pendiente' where id = p_id;
    perform _log(s.nombre, 'Reabrió confirmado para revisar', i.nombre);
  else
    raise exception 'ACCION_INVALIDA';
  end if;
  return json_build_object('ok', true);
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
  if g.clave is not null then perform _log(s.nombre, 'Quitó galardonado', g.nombre); end if;
  return json_build_object('ok', g.clave is not null);
end $$;

create or replace function galardonados_sin_lista(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones;
begin
  s := _admin(p_token);
  return coalesce((select json_agg(g.nombre order by g.clave) from galardonados g
    where not exists (select 1 from personas p where p.clave = g.clave)), '[]'::json);
end $$;

create or replace function borrar_listas(p_token uuid, p_que text) returns json
language plpgsql security definer set search_path = public as $$
declare s sesiones; v_n int;
begin
  s := _admin(p_token);
  if p_que = 'asistencia' then
    select count(*) into v_n from asistencia; delete from asistencia;
    perform _log(s.nombre, 'Borró todas las asistencias', v_n || ' registros');
  elsif p_que = 'confirmados' then
    select count(*) into v_n from inscritos; delete from inscritos;
    perform _log(s.nombre, 'Borró la lista de confirmados', v_n || ' nombres');
  elsif p_que = 'galardonados' then
    select count(*) into v_n from galardonados; delete from galardonados;
    perform _log(s.nombre, 'Borró la lista de galardonados', v_n || ' nombres');
  elsif p_que = 'nomina' then
    select count(*) into v_n from personas;
    delete from personas;                       -- también borra sus asistencias
    update inscritos set persona_id = null, estado = 'pendiente' where estado in ('auto', 'manual');
    perform _log(s.nombre, 'Borró la nómina y sus asistencias', v_n || ' personas');
  elsif p_que = 'todo' then
    delete from asistencia; delete from inscritos; delete from galardonados; delete from personas;
    perform _log(s.nombre, 'Borró todas las listas y asistencias', 'El historial se conserva');
  else
    raise exception 'ACCION_INVALIDA';
  end if;
  return json_build_object('ok', true);
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
      'marcados', (select count(*) from asistencia a where a.encargado_id = e.id),
      'familiares', (select coalesce(sum(a.familiares), 0) from asistencia a where a.encargado_id = e.id)
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
        'c', p.id in (select persona_id from inscritos where estado in ('auto', 'manual') and persona_id is not null),
        'por', a.registrado_por, 'fam', a.familiares, 'f', a.fecha) order by p.area, p.clave)
      from personas p
      left join galardonados g on g.clave = p.clave
      left join asistencia  a on a.persona_id = p.id), '[]'::json),
    'inscritos', coalesce((
      select json_agg(json_build_object('n', i.nombre, 'e', i.estado, 'p', p.nombre, 'a', p.area) order by i.nombre)
      from inscritos i left join personas p on p.id = i.persona_id), '[]'::json),
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
  marcar_asistencia(uuid, bigint, int),
  cambiar_familiares(uuid, bigint, int),
  quitar_asistencia(uuid, bigint),
  subir_personas(uuid, json, text),
  subir_confirmados(uuid, json, text),
  inscritos_revisar(uuid),
  inscrito_resolver(uuid, bigint, text, bigint),
  subir_galardonados(uuid, json, text),
  quitar_galardonado(uuid, text),
  galardonados_sin_lista(uuid),
  borrar_listas(uuid, text),
  encargados_listar(uuid),
  encargado_guardar(uuid, bigint, text, text, boolean),
  liberar_sesion(uuid, bigint),
  ver_historial(uuid, int),
  exportar(uuid),
  guardar_config(uuid, text, int)
to anon;

notify pgrst, 'reload schema';
