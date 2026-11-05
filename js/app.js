/* Familia EMETRA · Control de asistencia */
(function () {
  'use strict';

  // ---------------- Utilidades ----------------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  const fecha = (f) => f ? new Date(f).toLocaleString('es-GT', {
    timeZone: 'America/Guatemala', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
  const hora = (f) => f ? new Date(f).toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour: '2-digit', minute: '2-digit', hour12: false }) : '';

  const MENSAJES = {
    CREDENCIALES: 'Nombre o PIN incorrecto.',
    DATOS_INCOMPLETOS: 'Escribe tu nombre y tu PIN.',
    DESACTIVADO: 'Tu cuenta está desactivada. Habla con el administrador.',
    SESION_EN_USO: 'Ese PIN ya tiene una sesión abierta en otro celular. Pide al administrador que la libere.',
    BLOQUEADO: 'Demasiados intentos fallidos. Espera 10 minutos e intenta de nuevo.',
    SESION_EXPIRADA: 'Tu sesión se cerró. Vuelve a ingresar.',
    NO_AUTORIZADO: 'Solo el administrador puede hacer eso.',
    NO_PERMITIDO: 'Solo quien marcó esta asistencia puede quitarla.',
    NO_MARCADO: 'Esa asistencia ya no estaba marcada.',
    SOLO_ENCARGADOS: 'El administrador no marca asistencia; solo puede quitarla.',
    NOMBRE_APELLIDO: 'Escribe nombre y apellido.',
    NOMBRE_RESERVADO: 'Ese nombre está reservado.',
    PIN_INVALIDO: 'El PIN debe tener 4 dígitos.',
    PIN_ADMIN_INVALIDO: 'El PIN de administrador debe tener de 4 a 8 dígitos.',
    PIN_EN_USO: 'Ese PIN ya está en uso. Elige otro.',
    NOMBRE_EN_USO: 'Ya existe un encargado con ese nombre.',
    LIMITE_15: 'Ya hay 15 encargados.',
    TIEMPO_INVALIDO: 'El tiempo debe estar entre 5 y 240 minutos.',
    RED: 'Sin conexión. Revisa tu internet e intenta de nuevo.'
  };

  let toastT;
  function toast(msg, error) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (error ? ' error' : '');
    t.style.display = 'block';
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.style.display = 'none'), error ? 3800 : 2400);
  }
  function aviso(id, msg, error) {
    const el = $(id);
    if (!msg) { el.classList.add('hide'); return; }
    el.textContent = msg;
    el.className = 'aviso' + (error ? ' error' : '');
  }

  // ---------------- Conexión ----------------
  const cfg = window.CONFIG || {};
  const URL_OK = /^https:\/\/.+/.test(cfg.SUPABASE_URL || '') && cfg.SUPABASE_KEY && !/PEGA_AQUI/.test(cfg.SUPABASE_KEY);

  async function rpc(fn, args) {
    const headers = { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_KEY };
    if (String(cfg.SUPABASE_KEY).startsWith('eyJ')) headers.Authorization = 'Bearer ' + cfg.SUPABASE_KEY;
    let r;
    try {
      r = await fetch(cfg.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn, {
        method: 'POST', headers, body: JSON.stringify(args || {})
      });
    } catch (e) {
      const err = new Error(MENSAJES.RED); err.code = 'RED'; throw err;
    }
    const txt = await r.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (e) { /* vacío */ }
    if (!r.ok) {
      const code = (data && data.message) || 'ERROR';
      const err = new Error(MENSAJES[code] || ('Error: ' + code)); err.code = code;
      if (code === 'SESION_EXPIRADA') sesionPerdida();
      throw err;
    }
    return data;
  }

  // ---------------- Sesión ----------------
  const LLAVE = 'emetra_asistencia_sesion';
  let S = null;            // { token, rol, nombre }
  let personas = [];
  let seleccion = new Set();
  let huboActividad = true;
  let timer = null;

  function guardarSesion() { try { S ? localStorage.setItem(LLAVE, JSON.stringify(S)) : localStorage.removeItem(LLAVE); } catch (e) { /* sin almacenamiento */ } }
  function leerSesion() { try { return JSON.parse(localStorage.getItem(LLAVE) || 'null'); } catch (e) { return null; } }

  function vista(id) {
    ['vLogin', 'vEnc', 'vAdm', 'vConfig'].forEach((v) => $(v).classList.toggle('hide', v !== id));
    window.scrollTo(0, 0);
  }

  function sesionPerdida() {
    if (!S) return;
    S = null; guardarSesion(); detener();
    vista('vLogin');
    aviso('lErr', MENSAJES.SESION_EXPIRADA, true);
  }

  async function ingresar(e) {
    e.preventDefault();
    aviso('lErr', '');
    const b = $('bLogin'); b.disabled = true; b.textContent = 'Ingresando…';
    try {
      const r = await rpc('iniciar_sesion', { p_nombre: $('lNombre').value, p_pin: $('lPin').value.trim() });
      if (!r.ok) { aviso('lErr', MENSAJES[r.error] || r.error, true); return; }
      S = { token: r.token, rol: r.rol, nombre: r.nombre };
      guardarSesion();
      $('lPin').value = '';
      await arrancar();
    } catch (err) {
      aviso('lErr', err.message, true);
    } finally {
      b.disabled = false; b.textContent = 'Ingresar';
    }
  }

  async function salir() {
    if (!S) return;
    if (!confirm('¿Cerrar sesión?')) return;
    const tok = S.token;
    S = null; guardarSesion(); detener();
    try { await rpc('cerrar_sesion', { p_token: tok }); } catch (e) { /* igual se sale */ }
    seleccion.clear();
    vista('vLogin');
  }

  async function arrancar() {
    document.querySelectorAll('.jsNombre').forEach((el) => (el.textContent = S.nombre));
    seleccion.clear();
    await refrescar(true);
    if (!S) return;
    if (S.rol === 'admin') { vista('vAdm'); abrirTab('tResumen'); }
    else { vista('vEnc'); $('eBuscar').value = ''; }
    iniciar();
  }

  function iniciar() {
    detener();
    timer = setInterval(() => { if (!document.hidden) refrescar(false).catch(() => {}); },
      Math.max(3, Number(cfg.REFRESCO_SEGUNDOS) || 6) * 1000);
  }
  function detener() { clearInterval(timer); timer = null; }

  let ultimaCarga = null;
  async function refrescar(forzarActividad) {
    if (!S) return;
    const activo = forzarActividad || huboActividad;
    huboActividad = false;
    const r = await rpc('listar_personas', { p_token: S.token, p_activo: activo });
    personas = r.personas || [];
    ultimaCarga = r;
    if (S.rol === 'admin') { pintarResumen(); pintarAsistenciaAdm(); if (!$('ajTiempo').value) $('ajTiempo').value = r.timeout; }
    else { llenarAreas(); pintarLista(); }
  }

  // ---------------- Encargado ----------------
  function llenarAreas() {
    const sel = $('eArea');
    const actual = sel.value;
    const areas = [...new Set(personas.map((p) => p.a))].sort((a, b) => a.localeCompare(b, 'es'));
    const html = '<option value="">Todas las áreas</option>' + areas.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    if (sel.dataset.h !== html) { sel.innerHTML = html; sel.dataset.h = html; sel.value = areas.includes(actual) ? actual : ''; }
  }

  function coincide(p, q) {
    if (!q) return true;
    const k = norm(p.n);
    return k.startsWith(q) || k.split(' ').some((w) => w.startsWith(q));
  }

  function pintarLista() {
    const area = $('eArea').value;
    const q = norm($('eBuscar').value);
    const cont = $('eLista');
    if (!personas.length) { cont.innerHTML = '<div class="vacio">Todavía no hay personas cargadas.</div>'; $('eCont').textContent = ''; return barra(); }
    if (!area && !q) { cont.innerHTML = '<div class="vacio">Elige un área o escribe una letra para buscar.</div>'; $('eCont').textContent = ''; return barra(); }
    const lista = personas.filter((p) => (!area || p.a === area) && coincide(p, q));
    const presentes = lista.filter((p) => p.por).length;
    $('eCont').textContent = `${lista.length} ${lista.length === 1 ? 'persona' : 'personas'} · ${presentes} con asistencia`;
    if (!lista.length) { cont.innerHTML = '<div class="vacio">No hay nombres que coincidan.</div>'; return barra(); }
    const MAX = 300;
    cont.innerHTML = lista.slice(0, MAX).map((p) => {
      let cls = '', ic = '', sub = esc(p.a), fila = '';
      if (p.por) {
        if (p.mio) { cls = 'mia'; ic = '✓'; sub += ' · Marcado por ti ' + hora(p.f) + ' · toca para quitar'; }
        else { cls = 'ajena'; ic = '✓'; fila = ' ajena'; sub += ' · Marcado por ' + esc(p.por) + ' ' + hora(p.f); }
      } else if (seleccion.has(p.id)) { cls = 'sel'; ic = '✓'; }
      return `<div class="fila${p.g ? ' gal' : ''}${fila}" data-id="${p.id}">
        <div class="nm"><b>${esc(p.n)}${p.g ? '<span class="insignia">🏅 Galardonado</span>' : ''}</b><div class="sub">${sub}</div></div>
        <div class="casilla ${cls}">${ic}</div></div>`;
    }).join('') + (lista.length > MAX ? `<div class="vacio">Hay ${lista.length - MAX} más. Escribe más letras para encontrar el nombre.</div>` : '');
    barra();
  }

  function barra() {
    // quitar de la selección a quien ya marcó otra persona
    seleccion.forEach((id) => { const p = personas.find((x) => x.id === id); if (!p || p.por) seleccion.delete(id); });
    $('eBarra').classList.toggle('hide', !seleccion.size);
    $('bConfirmar').textContent = `✓ Confirmar asistencia (${seleccion.size})`;
  }

  async function tocarFila(ev) {
    const f = ev.target.closest('.fila'); if (!f) return;
    const id = Number(f.dataset.id);
    const p = personas.find((x) => x.id === id); if (!p) return;
    if (p.por) {
      if (!p.mio) { toast('Solo ' + p.por + ' puede quitar esta asistencia', true); return; }
      if (!confirm('¿Quitar la asistencia de ' + p.n + '?')) return;
      try {
        await rpc('quitar_asistencia', { p_token: S.token, p_persona_id: id });
        toast('Asistencia quitada');
        await refrescar(true);
      } catch (e) { toast(e.message, true); refrescar(true).catch(() => {}); }
      return;
    }
    seleccion.has(id) ? seleccion.delete(id) : seleccion.add(id);
    pintarLista();
  }

  async function confirmar() {
    if (!seleccion.size) return;
    const b = $('bConfirmar'); b.disabled = true;
    try {
      const r = await rpc('marcar_asistencia', { p_token: S.token, p_ids: [...seleccion] });
      seleccion.clear();
      let m = `✓ ${r.marcados} ${r.marcados === 1 ? 'asistencia registrada' : 'asistencias registradas'}`;
      if (r.ya_marcados) m += ` · ${r.ya_marcados} ya estaba${r.ya_marcados === 1 ? '' : 'n'} marcada${r.ya_marcados === 1 ? '' : 's'} por otro encargado`;
      toast(m, false);
      await refrescar(true);
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; }
  }

  // ---------------- Administrador ----------------
  function abrirTab(id) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('activa', b.dataset.tab === id));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hide', t.id !== id));
    if (id === 'tEnc') cargarEncargados();
    if (id === 'tHist') cargarHistorial();
    if (id === 'tAjustes') cargarGalSin();
  }

  function pintarResumen() {
    const total = personas.length;
    const asis = personas.filter((p) => p.por).length;
    $('sAsis').textContent = asis;
    $('sTotal').textContent = total;
    const galTot = personas.filter((p) => p.g).length;
    $('sGal').textContent = personas.filter((p) => p.g && p.por).length + (galTot ? '/' + galTot : '');
    const areas = {};
    personas.forEach((p) => { const a = (areas[p.a] = areas[p.a] || { t: 0, s: 0 }); a.t++; if (p.por) a.s++; });
    const filas = Object.keys(areas).sort((a, b) => a.localeCompare(b, 'es'));
    $('porArea').innerHTML = filas.length ? filas.map((a) => {
      const x = areas[a], pct = Math.round((x.s / x.t) * 100);
      return `<div class="item" style="display:block"><div style="display:flex;justify-content:space-between"><span>${esc(a)}</span><b>${x.s} / ${x.t}</b></div>
        <div class="barra-prog"><i style="width:${pct}%"></i></div></div>`;
    }).join('') : '<div class="vacio">Sube la lista de personas para empezar.</div>';
  }

  function pintarAsistenciaAdm() {
    const q = norm($('aBuscar').value);
    const filtro = (document.querySelector('input[name=aFiltro]:checked') || {}).value || 'si';
    let lista = personas.filter((p) => filtro === 'si' ? p.por : filtro === 'no' ? !p.por : p.g);
    if (q) lista = lista.filter((p) => coincide(p, q) || norm(p.a).includes(q));
    if (filtro === 'si') lista.sort((a, b) => String(b.f).localeCompare(String(a.f)));
    const MAX = 400;
    $('aLista').innerHTML = lista.length ? lista.slice(0, MAX).map((p) => `
      <div class="item${p.g ? ' gal' : ''}">
        <div><b>${esc(p.n)}${p.g ? ' 🏅' : ''}</b>
          <div class="sub">${esc(p.a)}${p.por ? ' · por ' + esc(p.por) + ' · ' + fecha(p.f) : ' · sin asistencia'}</div></div>
        ${p.por ? `<button class="enlace" data-quitar="${p.id}">Quitar</button>` : ''}
      </div>`).join('') + (lista.length > MAX ? `<div class="vacio">Y ${lista.length - MAX} más. Usa el buscador.</div>` : '')
      : '<div class="vacio">No hay registros.</div>';
  }

  async function quitarAdm(ev) {
    const b = ev.target.closest('[data-quitar]'); if (!b) return;
    const p = personas.find((x) => x.id === Number(b.dataset.quitar)); if (!p) return;
    if (!confirm(`¿Quitar la asistencia de ${p.n}?\nLa registró ${p.por}.`)) return;
    try { await rpc('quitar_asistencia', { p_token: S.token, p_persona_id: p.id }); toast('Asistencia quitada'); await refrescar(true); }
    catch (e) { toast(e.message, true); }
  }

  // --- Encargados
  let encargados = [];
  async function cargarEncargados() {
    try { encargados = await rpc('encargados_listar', { p_token: S.token }); } catch (e) { toast(e.message, true); return; }
    $('encCuenta').textContent = encargados.length;
    $('encLista').innerHTML = encargados.length ? encargados.map((e) => `
      <div class="item">
        <div><b>${esc(e.nombre)}</b><div class="sub">PIN ${esc(e.pin)} · ${e.marcados} marcados</div></div>
        <div class="acciones">
          ${!e.activo ? '<span class="pill inactivo">inactivo</span>' : e.en_sesion ? '<span class="pill">en sesión</span>' : '<span class="pill off">sin sesión</span>'}
          ${e.en_sesion ? `<button class="enlace" data-liberar="${e.id}">Liberar</button>` : ''}
          <button class="enlace" data-editar="${e.id}">Editar</button>
        </div>
      </div>`).join('') : '<div class="vacio">Crea las cuentas de tus encargados aquí arriba.</div>';
  }

  function limpiarFormEnc() {
    $('encId').value = ''; $('encNombre').value = ''; $('encPin').value = ''; $('encActivo').checked = true;
    $('encTitulo').textContent = 'Nuevo encargado'; $('bEncGuardar').textContent = 'Agregar encargado';
    $('bEncCancelar').classList.add('hide'); $('encActivoW').classList.add('hide'); aviso('encErr', '');
  }

  async function guardarEnc(ev) {
    ev.preventDefault(); aviso('encErr', '');
    const id = $('encId').value ? Number($('encId').value) : null;
    try {
      await rpc('encargado_guardar', { p_token: S.token, p_id: id, p_nombre: $('encNombre').value, p_pin: $('encPin').value.trim(), p_activo: $('encActivo').checked });
      toast(id ? 'Encargado actualizado' : 'Encargado agregado');
      limpiarFormEnc(); cargarEncargados();
    } catch (e) { aviso('encErr', e.message, true); }
  }

  async function accionEnc(ev) {
    const ed = ev.target.closest('[data-editar]');
    const lb = ev.target.closest('[data-liberar]');
    if (ed) {
      const e = encargados.find((x) => x.id === Number(ed.dataset.editar)); if (!e) return;
      $('encId').value = e.id; $('encNombre').value = e.nombre; $('encPin').value = e.pin; $('encActivo').checked = e.activo;
      $('encTitulo').textContent = 'Editar encargado'; $('bEncGuardar').textContent = 'Guardar cambios';
      $('bEncCancelar').classList.remove('hide'); $('encActivoW').classList.remove('hide');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    if (lb) {
      const e = encargados.find((x) => x.id === Number(lb.dataset.liberar)); if (!e) return;
      if (!confirm('¿Liberar la sesión de ' + e.nombre + '? Tendrá que volver a ingresar.')) return;
      try { await rpc('liberar_sesion', { p_token: S.token, p_encargado_id: e.id }); toast('Sesión liberada'); cargarEncargados(); }
      catch (err) { toast(err.message, true); }
    }
  }

  // --- Historial
  async function cargarHistorial() {
    try {
      const h = await rpc('ver_historial', { p_token: S.token, p_limite: 300 });
      $('histLista').innerHTML = h.length ? h.map((x) => `
        <div class="hist"><div class="t">${fecha(x.f)}</div><b>${esc(x.u)}</b> · ${esc(x.a)}${x.d ? ': ' + esc(x.d) : ''}</div>`).join('')
        : '<div class="vacio">Sin movimientos.</div>';
    } catch (e) { toast(e.message, true); }
  }

  // --- Ajustes
  async function guardarAjustes(ev) {
    ev.preventDefault(); aviso('ajRes', '');
    const pin = $('ajPin').value.trim();
    const t = Number($('ajTiempo').value) || null;
    try {
      await rpc('guardar_config', { p_token: S.token, p_admin_pin: pin || null, p_timeout: t });
      $('ajPin').value = '';
      aviso('ajRes', pin ? 'Ajustes guardados. Tu nuevo PIN ya está activo.' : 'Ajustes guardados.');
    } catch (e) { aviso('ajRes', e.message, true); }
  }

  async function cargarGalSin() {
    try {
      const r = await rpc('galardonados_sin_lista', { p_token: S.token });
      $('galSin').innerHTML = r.length ? r.map((n) => `<div class="item"><span>${esc(n)}</span><button class="enlace" data-galq="${esc(n)}">Quitar</button></div>`).join('')
        : '<div class="vacio">Todos los galardonados están en la lista.</div>';
    } catch (e) { toast(e.message, true); }
  }
  async function quitarGal(ev) {
    const b = ev.target.closest('[data-galq]'); if (!b) return;
    if (!confirm('¿Quitar a ' + b.dataset.galq + ' de los galardonados?')) return;
    try { await rpc('quitar_galardonado', { p_token: S.token, p_nombre: b.dataset.galq }); toast('Galardonado quitado'); cargarGalSin(); refrescar(true); }
    catch (e) { toast(e.message, true); }
  }

  // --- Excel: leer
  function leerExcel(file) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onerror = () => reject(new Error('No se pudo leer el archivo.'));
      rd.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const filas = [];
          const variasHojas = wb.SheetNames.length > 1;
          wb.SheetNames.forEach((hoja) => {
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { header: 1, defval: '', raw: false });
            if (!rows.length) return;
            // buscar fila de encabezados en las primeras 15 filas
            let hi = -1, cN = -1, cNs = -1, cAp = -1, cAr = -1;
            for (let i = 0; i < Math.min(15, rows.length) && hi < 0; i++) {
              rows[i].forEach((c, j) => {
                const k = norm(c);
                if (!k) return;
                if (k === 'nombres' || k === 'primer nombre') { if (cNs < 0) cNs = j; }
                else if (k.includes('apellido')) { if (cAp < 0) cAp = j; }
                else if (k.includes('nombre')) { if (cN < 0) cN = j; }
                else if (/(^| )(area|departamento|depto|dependencia|unidad|seccion|direccion)( |$)/.test(k)) { if (cAr < 0) cAr = j; }
              });
              if (cN >= 0 || cNs >= 0) hi = i; else { cN = cNs = cAp = cAr = -1; }
            }
            if (hi < 0) { cN = 0; cAr = 1; }
            for (let i = hi + 1; i < rows.length; i++) {
              const r = rows[i];
              let nombre = '';
              if (cNs >= 0 && cAp >= 0) nombre = `${r[cNs] || ''} ${r[cAp] || ''}`;
              else if (cN >= 0) nombre = r[cN];
              else if (cNs >= 0) nombre = r[cNs];
              nombre = String(nombre || '').replace(/\s+/g, ' ').trim();
              if (!norm(nombre)) continue;
              let area = cAr >= 0 ? String(r[cAr] || '').trim() : '';
              if (!area && variasHojas) area = hoja;
              filas.push({ nombre, area });
            }
          });
          resolve(filas);
        } catch (err) { reject(new Error('El archivo no parece un Excel válido.')); }
      };
      rd.readAsArrayBuffer(file);
    });
  }

  async function subir(input, tipo) {
    const file = input.files[0]; input.value = '';
    if (!file) return;
    if (typeof XLSX === 'undefined') { toast('No se cargó el lector de Excel. Revisa tu internet.', true); return; }
    aviso('subirRes', '');
    try {
      const filas = await leerExcel(file);
      if (!filas.length) { aviso('subirRes', 'No encontré nombres en el archivo. La columna debe llamarse "Nombre".', true); return; }
      const areas = new Set(filas.map((f) => f.area).filter(Boolean));
      const que = tipo === 'p' ? 'personas' : 'galardonados';
      const ej = filas.slice(0, 3).map((f) => f.nombre).join(', ');
      if (!confirm(`Se leyeron ${filas.length} nombres${tipo === 'p' ? ` en ${areas.size} área(s)` : ''}.\nEjemplo: ${ej}…\n\n¿Agregarlos a la lista de ${que}?`)) return;
      const r = await rpc(tipo === 'p' ? 'subir_personas' : 'subir_galardonados', { p_token: S.token, p_filas: filas, p_archivo: file.name });
      let m = `${file.name}: ${r.nuevos} nuevos agregados, ${r.existentes} ya existían (no se duplicaron).`;
      if (tipo === 'g' && r.sin_lista) m += ` ${r.sin_lista} galardonado(s) aún no están en la lista de personas (ver Ajustes).`;
      aviso('subirRes', m);
      await refrescar(true);
    } catch (e) { aviso('subirRes', e.message, true); }
  }

  // --- Excel: descargar
  async function descargar() {
    if (typeof XLSX === 'undefined') { toast('No se cargó el generador de Excel. Revisa tu internet.', true); return; }
    const b = $('bExcel'); b.disabled = true; b.textContent = 'Preparando…';
    try {
      const d = await rpc('exportar', { p_token: S.token });
      const encab = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0B1650' } }, alignment: { vertical: 'center' } };
      const rojo = { font: { bold: true, color: { rgb: 'C00000' } } };
      const hoja = (filas, cols, anchos, esGal) => {
        const ws = XLSX.utils.json_to_sheet(filas, { header: cols });
        cols.forEach((_, c) => { const ref = XLSX.utils.encode_cell({ r: 0, c }); if (ws[ref]) ws[ref].s = encab; });
        if (esGal) filas.forEach((f, i) => { if (esGal(f)) cols.forEach((_, c) => { const ref = XLSX.utils.encode_cell({ r: i + 1, c }); if (ws[ref]) ws[ref].s = rojo; }); });
        ws['!cols'] = anchos.map((w) => ({ wch: w }));
        ws['!autofilter'] = { ref: ws['!ref'] };
        return ws;
      };
      const gal = (f) => f['Galardonado'] === 'Sí';
      const asistentes = d.personas.filter((p) => p.por).sort((a, b) => String(a.f).localeCompare(String(b.f)))
        .map((p) => ({ 'Nombre': p.n, 'Área': p.a, 'Galardonado': p.g ? 'Sí' : 'No', 'Registrado por': p.por, 'Fecha y hora': fecha(p.f) }));
      const todos = d.personas.map((p) => ({ 'Nombre': p.n, 'Área': p.a, 'Galardonado': p.g ? 'Sí' : 'No', 'Asistió': p.por ? 'Sí' : 'No', 'Registrado por': p.por || '', 'Fecha y hora': fecha(p.f) }));
      const ar = {};
      d.personas.forEach((p) => { const x = (ar[p.a] = ar[p.a] || { t: 0, s: 0, g: 0, gs: 0 }); x.t++; if (p.por) x.s++; if (p.g) { x.g++; if (p.por) x.gs++; } });
      const resumen = Object.keys(ar).sort((a, b) => a.localeCompare(b, 'es')).map((a) => ({
        'Área': a, 'Total': ar[a].t, 'Asistieron': ar[a].s, 'Faltan': ar[a].t - ar[a].s,
        '% asistencia': ar[a].t ? Math.round((ar[a].s / ar[a].t) * 100) + '%' : '0%', 'Galardonados': ar[a].g, 'Galardonados presentes': ar[a].gs }));
      const T = resumen.reduce((s, r) => ({ t: s.t + r['Total'], s: s.s + r['Asistieron'], g: s.g + r['Galardonados'], gs: s.gs + r['Galardonados presentes'] }), { t: 0, s: 0, g: 0, gs: 0 });
      resumen.push({ 'Área': 'TOTAL', 'Total': T.t, 'Asistieron': T.s, 'Faltan': T.t - T.s, '% asistencia': T.t ? Math.round((T.s / T.t) * 100) + '%' : '0%', 'Galardonados': T.g, 'Galardonados presentes': T.gs });
      const porEnc = {};
      d.personas.forEach((p) => { if (p.por) porEnc[p.por] = (porEnc[p.por] || 0) + 1; });
      const historial = d.historial.map((h) => ({ 'Fecha y hora': fecha(h.f), 'Usuario': h.u || '', 'Acción': h.a, 'Detalle': h.d || '' }));

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, hoja(asistentes, ['Nombre', 'Área', 'Galardonado', 'Registrado por', 'Fecha y hora'], [34, 24, 13, 24, 22], gal), 'Asistentes');
      XLSX.utils.book_append_sheet(wb, hoja(todos, ['Nombre', 'Área', 'Galardonado', 'Asistió', 'Registrado por', 'Fecha y hora'], [34, 24, 13, 9, 24, 22], gal), 'Lista completa');
      XLSX.utils.book_append_sheet(wb, hoja(resumen, ['Área', 'Total', 'Asistieron', 'Faltan', '% asistencia', 'Galardonados', 'Galardonados presentes'], [26, 8, 11, 8, 13, 13, 22]), 'Resumen');
      XLSX.utils.book_append_sheet(wb, hoja(Object.keys(porEnc).sort().map((k) => ({ 'Encargado': k, 'Asistencias registradas': porEnc[k] })), ['Encargado', 'Asistencias registradas'], [28, 22]), 'Por encargado');
      XLSX.utils.book_append_sheet(wb, hoja(historial, ['Fecha y hora', 'Usuario', 'Acción', 'Detalle'], [22, 24, 30, 50]), 'Historial');
      if (d.galardonados_sin_lista.length)
        XLSX.utils.book_append_sheet(wb, hoja(d.galardonados_sin_lista.map((n) => ({ 'Galardonado sin coincidencia en la lista': n })), ['Galardonado sin coincidencia en la lista'], [44]), 'Galardonados sin lista');

      const ahora = new Date().toLocaleString('sv-SE', { timeZone: 'America/Guatemala' }).slice(0, 16).replace(' ', '_').replace(':', 'h');
      XLSX.writeFile(wb, `asistencia_emetra_${ahora}.xlsx`);
      toast('Excel descargado');
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; b.textContent = 'Descargar Excel'; }
  }

  // ---------------- Eventos ----------------
  function eventos() {
    $('fLogin').addEventListener('submit', ingresar);
    document.querySelectorAll('.jsSalir').forEach((b) => b.addEventListener('click', salir));
    ['click', 'input', 'touchstart', 'keydown'].forEach((t) => document.addEventListener(t, () => (huboActividad = true), { passive: true }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S) refrescar(true).catch(() => {}); });

    // encargado
    $('eArea').addEventListener('change', pintarLista);
    $('eBuscar').addEventListener('input', pintarLista);
    $('eLista').addEventListener('click', tocarFila);
    $('bConfirmar').addEventListener('click', confirmar);

    // admin
    $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) abrirTab(b.dataset.tab); });
    $('bSubirP').addEventListener('click', () => $('fPersonas').click());
    $('bSubirG').addEventListener('click', () => $('fGalard').click());
    $('fPersonas').addEventListener('change', (e) => subir(e.target, 'p'));
    $('fGalard').addEventListener('change', (e) => subir(e.target, 'g'));
    $('bExcel').addEventListener('click', descargar);
    $('aBuscar').addEventListener('input', pintarAsistenciaAdm);
    document.querySelectorAll('input[name=aFiltro]').forEach((r) => r.addEventListener('change', pintarAsistenciaAdm));
    $('aLista').addEventListener('click', quitarAdm);
    $('fEnc').addEventListener('submit', guardarEnc);
    $('bEncCancelar').addEventListener('click', limpiarFormEnc);
    $('encLista').addEventListener('click', accionEnc);
    $('bHistRef').addEventListener('click', cargarHistorial);
    $('fAjustes').addEventListener('submit', guardarAjustes);
    $('galSin').addEventListener('click', quitarGal);
  }

  // ---------------- Inicio ----------------
  async function inicio() {
    eventos();
    if (!URL_OK) { vista('vConfig'); return; }
    const guardada = leerSesion();
    if (guardada && guardada.token) {
      S = guardada;
      try { await arrancar(); return; } catch (e) { S = null; guardarSesion(); }
    }
    vista('vLogin');
  }
  inicio();
})();
