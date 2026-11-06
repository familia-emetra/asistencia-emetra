/* Familia EMETRA · Control de asistencia · v2 */
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
  const famTxt = (n) => `${n} ${n === 1 ? 'familiar' : 'familiares'}`;

  const MENSAJES = {
    CREDENCIALES: 'Nombre o PIN incorrecto.',
    DATOS_INCOMPLETOS: 'Escribe tu nombre y tu PIN.',
    DESACTIVADO: 'Tu cuenta está desactivada. Habla con el administrador.',
    SESION_EN_USO: 'Ese PIN ya tiene una sesión abierta en otro celular. Pide al administrador que la libere.',
    BLOQUEADO: 'Demasiados intentos fallidos. Espera 10 minutos e intenta de nuevo.',
    SESION_EXPIRADA: 'Tu sesión se cerró. Vuelve a ingresar.',
    NO_AUTORIZADO: 'Solo el administrador puede hacer eso.',
    NO_PERMITIDO: 'Solo quien registró esta asistencia puede cambiarla.',
    NO_MARCADO: 'Esa asistencia ya no estaba marcada.',
    NO_EXISTE: 'Ese registro ya no existe. Actualiza la página.',
    SOLO_ENCARGADOS: 'El administrador no marca asistencia; solo puede corregirla o quitarla.',
    FAMILIARES_INVALIDO: 'El número de familiares no es válido.',
    NOMBRE_APELLIDO: 'Escribe nombre y apellido.',
    NOMBRE_RESERVADO: 'Ese nombre está reservado.',
    PIN_INVALIDO: 'El PIN debe tener 4 dígitos.',
    PIN_ADMIN_INVALIDO: 'El PIN de administrador debe tener de 4 a 8 dígitos.',
    PIN_EN_USO: 'Ese PIN ya está en uso. Elige otro.',
    NOMBRE_EN_USO: 'Ya existe un encargado con ese nombre.',
    LIMITE_15: 'Ya hay 15 encargados.',
    TIEMPO_INVALIDO: 'El tiempo debe estar entre 5 y 240 minutos.',
    ACCION_INVALIDA: 'Acción no válida.',
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
  const URL_OK = /^https?:\/\/.+/.test(cfg.SUPABASE_URL || '') && cfg.SUPABASE_KEY && !/PEGA_AQUI/.test(cfg.SUPABASE_KEY);

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
  let huboActividad = true;
  let timer = null;
  let abierto = null;      // id de la persona con el panel abierto (encargado)
  let contador = 0;        // familiares en el panel abierto
  let ocupado = false;

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
    abierto = null;
    vista('vLogin');
  }

  async function arrancar() {
    document.querySelectorAll('.jsNombre').forEach((el) => (el.textContent = S.nombre));
    abierto = null;
    await refrescar(true);
    if (!S) return;
    if (S.rol === 'admin') { vista('vAdm'); abrirTab('tResumen'); }
    else { vista('vEnc'); $('eBuscar').value = ''; }
    iniciar();
  }

  function iniciar() {
    detener();
    timer = setInterval(() => { if (!document.hidden && !ocupado) refrescar(false).catch(() => {}); },
      Math.max(3, Number(cfg.REFRESCO_SEGUNDOS) || 6) * 1000);
  }
  function detener() { clearInterval(timer); timer = null; }

  let pendientes = 0;
  async function refrescar(forzarActividad) {
    if (!S) return;
    const activo = forzarActividad || huboActividad;
    huboActividad = false;
    const r = await rpc('listar_personas', { p_token: S.token, p_activo: activo });
    personas = r.personas || [];
    if (S.rol === 'admin') {
      pendientes = r.pendientes || 0;
      $('globoRev').textContent = pendientes;
      $('globoRev').classList.toggle('hide', !pendientes);
      pintarResumen(); pintarAsistenciaAdm();
      if (!$('ajTiempo').value) $('ajTiempo').value = r.timeout;
    } else { llenarAreas(); pintarLista(); }
  }

  // ---------------- Encargado ----------------
  function llenarAreas() {
    const sel = $('eArea');
    const actual = sel.value;
    const areas = [...new Set(personas.map((p) => p.a))].sort((a, b) => a.localeCompare(b, 'es'));
    const html = '<option value="">Todas las áreas</option>' + areas.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    if (sel.dataset.h !== html) { sel.innerHTML = html; sel.dataset.h = html; sel.value = areas.includes(actual) ? actual : ''; }
  }

  // Búsqueda por palabras: cada palabra escrita debe ser el inicio de alguna palabra del nombre,
  // en cualquier orden. "jose hernandez" encuentra "José Luis Hernández García".
  function coincide(p, q) {
    if (!q) return true;
    const palabras = norm(p.n).split(' ');
    return q.split(' ').every((t) => palabras.some((w) => w.startsWith(t)));
  }

  // Puntaje para ordenar: menor = mejor coincidencia.
  function puntaje(p, q) {
    if (!q) return 0;
    const k = norm(p.n), palabras = k.split(' '), ts = q.split(' ');
    let s = 0;
    if (!k.startsWith(q)) s += 4;                                   // no empieza igual que lo escrito
    if (!palabras[0].startsWith(ts[0])) s += 2;                     // la primera palabra no es el primer nombre
    ts.forEach((t) => { if (!palabras.includes(t)) s += 1; });      // palabras incompletas
    let pos = -1, enOrden = true;                                   // palabras en el mismo orden
    ts.forEach((t) => { const i = palabras.findIndex((w, j) => j > pos && w.startsWith(t)); if (i < 0) enOrden = false; else pos = i; });
    if (!enOrden) s += 1;
    return s;
  }
  const ordenar = (lista, q) => q ? lista.map((p) => [puntaje(p, q), p]).sort((a, b) => a[0] - b[0] || a[1].n.localeCompare(b[1].n, 'es')).map((x) => x[1]) : lista;

  // Botón ✕ grande para limpiar un buscador
  function botonLimpiar(input, alLimpiar) {
    if (!document.getElementById('estiloBuscar')) {
      const st = document.createElement('style'); st.id = 'estiloBuscar';
      st.textContent = 'input[type=search]::-webkit-search-cancel-button{-webkit-appearance:none;display:none}';
      document.head.appendChild(st);
    }
    const caja = document.createElement('div');
    caja.style.cssText = 'position:relative';
    input.parentNode.insertBefore(caja, input);
    caja.appendChild(input);
    input.style.paddingRight = '56px';
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = '✕'; b.setAttribute('aria-label', 'Borrar búsqueda');
    b.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);width:42px;height:42px;border-radius:50%;' +
      'border:none;background:#d9b97a;color:#0b1650;font-size:20px;font-weight:800;cursor:pointer;display:none';
    caja.appendChild(b);
    const ver = () => (b.style.display = input.value ? 'block' : 'none');
    input.addEventListener('input', ver);
    b.addEventListener('click', () => { input.value = ''; ver(); input.focus(); alLimpiar(); });
    return ver;
  }

  function nombreHTML(p) {
    return `${esc(p.n)}${p.g ? ' 🏅' : ''}${p.c ? '<span class="conf" title="Confirmó">✅</span>' : ''}`;
  }

  function panelHTML(p) {
    const cont = `<div class="lbl">Familiares que lo acompañan</div>
      <div class="contador-fam">
        <button type="button" data-acc="menos" aria-label="Quitar uno">–</button>
        <span class="num">${contador}</span>
        <button type="button" data-acc="mas" aria-label="Agregar uno">+</button>
      </div>`;
    if (!p.por) {
      return `<div class="panel">
        ${p.c ? '' : '<div class="aviso-mini">⚠️ Esta persona no confirmó asistencia. Puedes registrarla igual.</div>'}
        ${cont}
        <div class="botones">
          <button class="btn borde" type="button" data-acc="cerrar">Cancelar</button>
          <button class="btn lima" type="button" data-acc="confirmar">✓ Confirmar asistencia</button>
        </div></div>`;
    }
    return `<div class="panel">${cont}
      <div class="botones">
        <button class="btn peligro" type="button" data-acc="quitar">Quitar asistencia</button>
        <button class="btn" type="button" data-acc="guardar">Guardar familiares</button>
      </div></div>`;
  }

  function pintarLista() {
    const area = $('eArea').value;
    const q = norm($('eBuscar').value);
    const cont = $('eLista');
    if (!personas.length) { cont.innerHTML = '<div class="vacio">Todavía no hay personas cargadas.</div>'; $('eCont').textContent = ''; return; }
    if (!area && !q) { cont.innerHTML = '<div class="vacio">Elige un área o escribe una letra para buscar.</div>'; $('eCont').textContent = ''; return; }
    const lista = ordenar(personas.filter((p) => (!area || p.a === area) && coincide(p, q)), q);
    // si la persona abierta la registró otro encargado mientras tanto, se cierra
    const pa = personas.find((x) => x.id === abierto);
    if (!pa || (pa.por && !pa.mio)) abierto = null;
    const presentes = lista.filter((p) => p.por).length;
    const conf = lista.filter((p) => p.c).length;
    $('eCont').textContent = `${lista.length} ${lista.length === 1 ? 'persona' : 'personas'} · ${conf} confirmaron · ${presentes} con asistencia`;
    if (!lista.length) { cont.innerHTML = '<div class="vacio">No hay nombres que coincidan.</div>'; return; }
    const MAX = 300;
    cont.innerHTML = lista.slice(0, MAX).map((p) => {
      let cls = '', ic = '', sub = esc(p.a), fila = '';
      if (p.por) {
        sub += ` · <span class="fam">👨‍👩‍👧 ${famTxt(p.fam)}</span>`;
        if (p.mio) { cls = 'mia'; ic = '✓'; sub += ' · por ti ' + hora(p.f); }
        else { cls = 'ajena'; ic = '✓'; fila = ' ajena'; sub += ' · por ' + esc(p.por) + ' ' + hora(p.f); }
      } else if (!p.c) { sub += ' · no confirmó'; }
      const ab = p.id === abierto;
      return `<div class="fila${p.g ? ' gal' : ''}${fila}${ab ? ' abierta' : ''}" data-id="${p.id}">
        <div class="nm"><b>${nombreHTML(p)}</b><div class="sub">${sub}</div></div>
        <div class="casilla ${cls}">${ic}</div></div>${ab ? panelHTML(p) : ''}`;
    }).join('') + (lista.length > MAX ? `<div class="vacio">Hay ${lista.length - MAX} más. Escribe más letras para encontrar el nombre.</div>` : '');
  }

  async function clicLista(ev) {
    const acc = ev.target.closest('[data-acc]');
    if (acc) { await accionPanel(acc.dataset.acc); return; }
    if (ev.target.closest('.panel')) return;
    const f = ev.target.closest('.fila'); if (!f) return;
    const id = Number(f.dataset.id);
    const p = personas.find((x) => x.id === id); if (!p) return;
    if (p.por && !p.mio) { toast('Solo ' + p.por + ' puede cambiar esta asistencia', true); return; }
    if (abierto === id) { abierto = null; }
    else { abierto = id; contador = p.por ? (p.fam || 0) : 0; }
    pintarLista();
  }

  async function accionPanel(acc) {
    const p = personas.find((x) => x.id === abierto); if (!p) return;
    if (acc === 'mas') { contador++; pintarLista(); return; }
    if (acc === 'menos') { contador = Math.max(0, contador - 1); pintarLista(); return; }
    if (acc === 'cerrar') { abierto = null; pintarLista(); return; }
    if (ocupado) return;
    ocupado = true;
    try {
      if (acc === 'confirmar') {
        const r = await rpc('marcar_asistencia', { p_token: S.token, p_persona_id: p.id, p_familiares: contador });
        if (r.ok) toast(`✓ ${p.n} registrado con ${famTxt(contador)}`);
        else toast(`${p.n} ya había sido registrado por ${r.por}`, true);
        abierto = null;
      } else if (acc === 'guardar') {
        await rpc('cambiar_familiares', { p_token: S.token, p_persona_id: p.id, p_familiares: contador });
        toast(`Familiares actualizados: ${contador}`);
        abierto = null;
      } else if (acc === 'quitar') {
        if (!confirm('¿Quitar la asistencia de ' + p.n + '?')) return;
        await rpc('quitar_asistencia', { p_token: S.token, p_persona_id: p.id });
        toast('Asistencia quitada');
        abierto = null;
      }
    } catch (e) { toast(e.message, true); }
    finally { ocupado = false; await refrescar(true).catch(() => {}); }
  }

  // ---------------- Administrador ----------------
  function abrirTab(id) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('activa', b.dataset.tab === id));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hide', t.id !== id));
    if (id === 'tEnc') cargarEncargados();
    if (id === 'tHist') cargarHistorial();
    if (id === 'tAjustes') cargarGalSin();
    if (id === 'tRevisar') cargarRevisar();
  }

  function totales(lista) {
    const t = { nom: 0, conf: 0, asis: 0, fam: 0, sinConf: 0, cnl: 0, gal: 0, galP: 0 };
    lista.forEach((p) => {
      t.nom++;
      if (p.c) t.conf++;
      if (p.por) { t.asis++; t.fam += p.fam || 0; if (!p.c) t.sinConf++; }
      if (p.c && !p.por) t.cnl++;
      if (p.g) { t.gal++; if (p.por) t.galP++; }
    });
    t.total = t.asis + t.fam;
    return t;
  }

  function pintarResumen() {
    const t = totales(personas);
    $('sNom').textContent = t.nom;
    $('sConf').textContent = t.conf;
    $('sAsis').textContent = t.asis;
    $('sFam').textContent = t.fam;
    $('sTotal').textContent = t.total;
    $('sGal').textContent = t.galP + (t.gal ? '/' + t.gal : '');
    aviso('avisoRev', pendientes ? `Hay ${pendientes} confirmado(s) por revisar: sus nombres no se pudieron cruzar solos con la nómina. Ve a la pestaña "Por revisar".` : '');
    const areas = {};
    personas.forEach((p) => (areas[p.a] = areas[p.a] || []).push(p));
    const filas = Object.keys(areas).sort((a, b) => a.localeCompare(b, 'es'));
    $('porArea').innerHTML = filas.length ? filas.map((a) => {
      const x = totales(areas[a]), pct = Math.round((x.asis / x.nom) * 100);
      return `<div class="item" style="display:block">
        <div style="display:flex;justify-content:space-between;gap:8px"><span>${esc(a)}</span><b>${x.asis} / ${x.nom}</b></div>
        <div class="sub">✅ ${x.conf} confirmaron · 👨‍👩‍👧 ${x.fam} familiares · ${x.total} personas en total</div>
        <div class="barra-prog"><i style="width:${pct}%"></i></div></div>`;
    }).join('') : '<div class="vacio">Sube la nómina para empezar.</div>';
  }

  function pintarAsistenciaAdm() {
    const q = norm($('aBuscar').value);
    const filtro = (document.querySelector('input[name=aFiltro]:checked') || {}).value || 'si';
    let lista = personas.filter((p) => filtro === 'si' ? p.por : filtro === 'no' ? !p.por : filtro === 'cnl' ? (p.c && !p.por) : p.g);
    if (q) lista = ordenar(lista.filter((p) => coincide(p, q) || norm(p.a).includes(q)), q);
    else if (filtro === 'si') lista.sort((a, b) => String(b.f).localeCompare(String(a.f)));
    const MAX = 400;
    $('aLista').innerHTML = lista.length ? lista.slice(0, MAX).map((p) => `
      <div class="item${p.g ? ' gal' : ''}">
        <div><b>${nombreHTML(p)}</b>
          <div class="sub">${esc(p.a)}${p.por ? ` · 👨‍👩‍👧 ${famTxt(p.fam)} · por ${esc(p.por)} · ${fecha(p.f)}` : (p.c ? ' · confirmó, sin asistencia' : ' · sin asistencia')}</div></div>
        ${p.por ? `<div class="acciones"><button class="enlace" data-fam="${p.id}">Familiares</button><button class="enlace" data-quitar="${p.id}">Quitar</button></div>` : ''}
      </div>`).join('') + (lista.length > MAX ? `<div class="vacio">Y ${lista.length - MAX} más. Usa el buscador.</div>` : '')
      : '<div class="vacio">No hay registros.</div>';
  }

  async function accionAsisAdm(ev) {
    const bq = ev.target.closest('[data-quitar]');
    const bf = ev.target.closest('[data-fam]');
    const id = Number((bq || bf || {}).dataset?.quitar || (bf || {}).dataset?.fam);
    const p = personas.find((x) => x.id === id); if (!p) return;
    try {
      if (bq) {
        if (!confirm(`¿Quitar la asistencia de ${p.n}?\nLa registró ${p.por} con ${famTxt(p.fam)}.`)) return;
        await rpc('quitar_asistencia', { p_token: S.token, p_persona_id: p.id });
        toast('Asistencia quitada');
      } else if (bf) {
        const v = prompt(`Familiares de ${p.n} (ahora: ${p.fam}):`, p.fam);
        if (v === null) return;
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 0) { toast('Escribe un número válido', true); return; }
        await rpc('cambiar_familiares', { p_token: S.token, p_persona_id: p.id, p_familiares: n });
        toast('Familiares actualizados');
      }
      await refrescar(true);
    } catch (e) { toast(e.message, true); }
  }

  // --- Por revisar
  let revisar = { pendientes: [], resueltos: [] };
  async function cargarRevisar() {
    try { revisar = await rpc('inscritos_revisar', { p_token: S.token }); } catch (e) { toast(e.message, true); return; }
    const chip = (insId, c) => `<button class="chip" data-asig="${insId}" data-p="${c.id}">${esc(c.n)} <small>· ${esc(c.a)}</small></button>`;
    $('revLista').innerHTML = revisar.pendientes.length ? revisar.pendientes.map((i) => `
      <div class="rev">
        <div class="ins">"${esc(i.n)}"<small>Así se inscribió. ¿Quién es en la nómina?</small></div>
        <div class="chips">${i.cand.length ? i.cand.map((c) => chip(i.id, c)).join('') : '<span class="sub">Sin sugerencias. Búscalo abajo.</span>'}</div>
        <input type="search" placeholder="Buscar en la nómina…" data-buscar="${i.id}" autocomplete="off">
        <div class="chips" id="rb-${i.id}"></div>
        <button class="enlace" data-nonom="${i.id}" style="margin-top:8px">No está en la nómina</button>
      </div>`).join('') : '<div class="tarjeta"><div class="vacio">✅ No hay nada por revisar.</div></div>';
    $('revResueltos').innerHTML = revisar.resueltos.length ? revisar.resueltos.map((i) => `
      <div class="item"><div><b>"${esc(i.n)}"</b><div class="sub">${i.e === 'manual' ? '→ ' + esc(i.p) + ' · ' + esc(i.a) : 'No está en la nómina'}</div></div>
      <button class="enlace" data-reabrir="${i.id}">Reabrir</button></div>`).join('') : '<div class="vacio">Ninguno.</div>';
  }

  function buscarRevisar(ev) {
    const inp = ev.target.closest('[data-buscar]'); if (!inp) return;
    const id = inp.dataset.buscar, q = norm(inp.value);
    const res = q.length < 2 ? [] : ordenar(personas.filter((p) => coincide(p, q)), q).slice(0, 8);
    $('rb-' + id).innerHTML = res.map((c) => `<button class="chip" data-asig="${id}" data-p="${c.id}">${esc(c.n)} <small>· ${esc(c.a)}</small></button>`).join('')
      || (q.length >= 2 ? '<span class="sub">Sin resultados.</span>' : '');
  }

  async function accionRevisar(ev) {
    const a = ev.target.closest('[data-asig]');
    const nn = ev.target.closest('[data-nonom]');
    const ra = ev.target.closest('[data-reabrir]');
    try {
      if (a) {
        const ins = revisar.pendientes.find((x) => x.id === Number(a.dataset.asig));
        const p = personas.find((x) => x.id === Number(a.dataset.p));
        if (!ins || !p) return;
        if (!confirm(`¿"${ins.n}" es ${p.n} (${p.a})?`)) return;
        await rpc('inscrito_resolver', { p_token: S.token, p_id: ins.id, p_accion: 'asignar', p_persona_id: p.id });
        toast('✅ Cruzado con ' + p.n);
      } else if (nn) {
        const ins = revisar.pendientes.find((x) => x.id === Number(nn.dataset.nonom));
        if (!ins || !confirm(`¿Marcar "${ins.n}" como que no está en la nómina?`)) return;
        await rpc('inscrito_resolver', { p_token: S.token, p_id: ins.id, p_accion: 'no_nomina' });
        toast('Marcado como fuera de la nómina');
      } else if (ra) {
        await rpc('inscrito_resolver', { p_token: S.token, p_id: Number(ra.dataset.reabrir), p_accion: 'reabrir' });
        toast('Vuelve a "Por revisar"');
      } else return;
      await cargarRevisar(); await refrescar(true);
    } catch (e) { toast(e.message, true); }
  }

  // --- Encargados
  let encargados = [];
  async function cargarEncargados() {
    try { encargados = await rpc('encargados_listar', { p_token: S.token }); } catch (e) { toast(e.message, true); return; }
    $('encCuenta').textContent = encargados.length;
    $('encLista').innerHTML = encargados.length ? encargados.map((e) => `
      <div class="item">
        <div><b>${esc(e.nombre)}</b><div class="sub">PIN ${esc(e.pin)} · ${e.marcados} registrados · ${e.familiares} familiares</div></div>
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

  async function borrar() {
    const sel = $('borrarQue');
    const que = sel.value;
    if (!que) { toast('Elige qué quieres borrar', true); return; }
    const txt = sel.options[sel.selectedIndex].text;
    const v = prompt(`Vas a borrar: ${txt}.\nEsto no se puede deshacer.\n\nEscribe BORRAR para confirmar:`);
    if (v === null) return;
    if (v.trim().toUpperCase() !== 'BORRAR') { toast('No se borró nada', true); return; }
    try {
      await rpc('borrar_listas', { p_token: S.token, p_que: que });
      toast('Listo, se borró: ' + txt);
      sel.value = '';
      await refrescar(true); cargarGalSin();
    } catch (e) { toast(e.message, true); }
  }

  async function cargarGalSin() {
    try {
      const r = await rpc('galardonados_sin_lista', { p_token: S.token });
      $('galSin').innerHTML = r.length ? r.map((n) => `<div class="item"><span>${esc(n)}</span><button class="enlace" data-galq="${esc(n)}">Quitar</button></div>`).join('')
        : '<div class="vacio">Todos los galardonados están en la nómina.</div>';
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

  const TIPOS = {
    p: { fn: 'subir_personas', que: 'la nómina' },
    c: { fn: 'subir_confirmados', que: 'la lista de confirmados' },
    g: { fn: 'subir_galardonados', que: 'la lista de galardonados' }
  };

  async function subir(input, tipo) {
    const file = input.files[0]; input.value = '';
    if (!file) return;
    if (typeof XLSX === 'undefined') { toast('No se cargó el lector de Excel. Revisa tu internet.', true); return; }
    aviso('subirRes', '');
    try {
      let filas = await leerExcel(file);
      if (!filas.length) { aviso('subirRes', 'No encontré nombres en el archivo. La columna debe llamarse "Nombre".', true); return; }
      if (tipo !== 'p') filas = filas.map((f) => ({ nombre: f.nombre }));   // el área de la inscripción se ignora
      const areas = new Set(filas.map((f) => f.area).filter(Boolean));
      const ej = filas.slice(0, 3).map((f) => f.nombre).join(', ');
      if (!confirm(`Se leyeron ${filas.length} nombres${tipo === 'p' ? ` en ${areas.size} área(s)` : ''}.\nEjemplo: ${ej}…\n\n¿Agregarlos a ${TIPOS[tipo].que}?`)) return;
      const r = await rpc(TIPOS[tipo].fn, { p_token: S.token, p_filas: filas, p_archivo: file.name });
      let m = `${file.name}: ${r.nuevos} nuevos, ${r.existentes} ya existían (no se duplicaron).`;
      if (tipo === 'p' && r.cruzados) m += ` Además se cruzaron ${r.cruzados} confirmados que estaban pendientes.`;
      if (tipo === 'c') m += ` ✅ ${r.cruzados} se cruzaron solos con la nómina.` + (r.pendientes ? ` ${r.pendientes} quedaron en "Por revisar".` : '');
      if (tipo === 'g' && r.sin_lista) m += ` ${r.sin_lista} galardonado(s) aún no están en la nómina (ver Ajustes).`;
      aviso('subirRes', m);
      await refrescar(true);
    } catch (e) { aviso('subirRes', e.message, true); }
  }

  // --- Excel: descargar (reporte final)
  async function descargar() {
    if (typeof XLSX === 'undefined') { toast('No se cargó el generador de Excel. Revisa tu internet.', true); return; }
    const b = $('bExcel'); b.disabled = true; b.textContent = 'Preparando…';
    try {
      const d = await rpc('exportar', { p_token: S.token });
      const encab = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0B1650' } }, alignment: { vertical: 'center', wrapText: true } };
      const rojo = { font: { bold: true, color: { rgb: 'C00000' } } };
      const negrita = { font: { bold: true }, fill: { fgColor: { rgb: 'EAD3A3' } } };
      const hoja = (filas, cols, anchos, opciones) => {
        const o = opciones || {};
        const ws = XLSX.utils.json_to_sheet(filas, { header: cols });
        cols.forEach((_, c) => { const ref = XLSX.utils.encode_cell({ r: 0, c }); if (ws[ref]) ws[ref].s = encab; });
        filas.forEach((f, i) => {
          const est = o.esGal && o.esGal(f) ? rojo : (o.esTotal && o.esTotal(f) ? negrita : null);
          if (est) cols.forEach((_, c) => { const ref = XLSX.utils.encode_cell({ r: i + 1, c }); if (ws[ref]) ws[ref].s = est; });
        });
        ws['!cols'] = anchos.map((w) => ({ wch: w }));
        if (filas.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: filas.length, c: cols.length - 1 } }) };
        return ws;
      };
      const si = (v) => (v ? 'Sí' : 'No');
      const gal = (f) => f['Galardonado'] === 'Sí';
      const P = d.personas;

      // 1. Resumen por área
      const grupos = {};
      P.forEach((p) => (grupos[p.a] = grupos[p.a] || []).push(p));
      const filaRes = (nombre, lista) => {
        const t = totales(lista.map((p) => ({ ...p, por: p.por, fam: p.fam || 0 })));
        return { 'Área': nombre, 'Nómina': t.nom, 'Confirmaron': t.conf, 'Asistieron': t.asis,
          'Asistieron sin confirmar': t.sinConf, 'Confirmaron y no llegaron': t.cnl, 'Familiares': t.fam,
          'Total personas en el evento': t.total, '% asistencia': t.nom ? Math.round((t.asis / t.nom) * 100) + '%' : '0%',
          'Galardonados': t.gal, 'Galardonados presentes': t.galP };
      };
      const resumen = Object.keys(grupos).sort((a, b) => a.localeCompare(b, 'es')).map((a) => filaRes(a, grupos[a]));
      resumen.push(filaRes('TOTAL', P));
      const colsRes = ['Área', 'Nómina', 'Confirmaron', 'Asistieron', 'Asistieron sin confirmar', 'Confirmaron y no llegaron', 'Familiares', 'Total personas en el evento', '% asistencia', 'Galardonados', 'Galardonados presentes'];
      const wsRes = hoja(resumen, colsRes, [26, 9, 12, 11, 14, 14, 11, 14, 12, 12, 14], { esTotal: (f) => f['Área'] === 'TOTAL' });
      const insNoNom = d.inscritos.filter((i) => i.e === 'no_nomina').length;
      const insPend = d.inscritos.filter((i) => i.e === 'pendiente').length;
      XLSX.utils.sheet_add_aoa(wsRes, [[], ['Reporte generado', fecha(new Date())],
        ['Confirmados en la lista de inscripción', d.inscritos.length],
        ['Confirmados que no están en la nómina', insNoNom],
        ['Confirmados sin revisar', insPend]], { origin: -1 });

      // 2. Asistentes
      const asistentes = P.filter((p) => p.por).sort((a, b) => String(a.f).localeCompare(String(b.f)))
        .map((p) => ({ 'Nombre': p.n, 'Área': p.a, 'Confirmó': si(p.c), 'Galardonado': si(p.g), 'Familiares': p.fam || 0,
          'Total (persona + familiares)': 1 + (p.fam || 0), 'Registrado por': p.por, 'Fecha y hora': fecha(p.f) }));
      // 3. Nómina completa
      const nomina = P.map((p) => ({ 'Nombre': p.n, 'Área': p.a, 'Confirmó': si(p.c), 'Galardonado': si(p.g), 'Asistió': si(p.por),
        'Familiares': p.por ? (p.fam || 0) : '', 'Registrado por': p.por || '', 'Fecha y hora': fecha(p.f) }));
      // 4. Confirmaron y no llegaron
      const cnl = P.filter((p) => p.c && !p.por).map((p) => ({ 'Nombre': p.n, 'Área': p.a, 'Galardonado': si(p.g) }));
      // 5. Confirmados (cruce)
      const EST = { auto: 'Cruzado automático', manual: 'Cruzado a mano', pendiente: 'Sin revisar', no_nomina: 'No está en la nómina' };
      const inscritos = d.inscritos.map((i) => ({ 'Nombre como se inscribió': i.n, 'Resultado': EST[i.e] || i.e, 'Persona en la nómina': i.p || '', 'Área (nómina)': i.a || '' }));
      // 6. Por encargado
      const pe = {};
      P.forEach((p) => { if (p.por) { const x = (pe[p.por] = pe[p.por] || { n: 0, f: 0 }); x.n++; x.f += p.fam || 0; } });
      const porEnc = Object.keys(pe).sort().map((k) => ({ 'Encargado': k, 'Personas registradas': pe[k].n, 'Familiares': pe[k].f, 'Total': pe[k].n + pe[k].f }));
      // 7. Historial
      const historial = d.historial.map((h) => ({ 'Fecha y hora': fecha(h.f), 'Usuario': h.u || '', 'Acción': h.a, 'Detalle': h.d || '' }));

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, wsRes, 'Resumen');
      XLSX.utils.book_append_sheet(wb, hoja(asistentes, ['Nombre', 'Área', 'Confirmó', 'Galardonado', 'Familiares', 'Total (persona + familiares)', 'Registrado por', 'Fecha y hora'], [34, 22, 10, 12, 11, 14, 22, 22], { esGal: gal }), 'Asistentes');
      XLSX.utils.book_append_sheet(wb, hoja(nomina, ['Nombre', 'Área', 'Confirmó', 'Galardonado', 'Asistió', 'Familiares', 'Registrado por', 'Fecha y hora'], [34, 22, 10, 12, 9, 11, 22, 22], { esGal: gal }), 'Nómina completa');
      XLSX.utils.book_append_sheet(wb, hoja(cnl, ['Nombre', 'Área', 'Galardonado'], [34, 22, 12], { esGal: gal }), 'Confirmaron y no llegaron');
      XLSX.utils.book_append_sheet(wb, hoja(inscritos, ['Nombre como se inscribió', 'Resultado', 'Persona en la nómina', 'Área (nómina)'], [34, 22, 34, 22]), 'Confirmados (cruce)');
      XLSX.utils.book_append_sheet(wb, hoja(porEnc, ['Encargado', 'Personas registradas', 'Familiares', 'Total'], [28, 20, 12, 10]), 'Por encargado');
      XLSX.utils.book_append_sheet(wb, hoja(historial, ['Fecha y hora', 'Usuario', 'Acción', 'Detalle'], [22, 24, 34, 60]), 'Historial');
      if (d.galardonados_sin_lista.length)
        XLSX.utils.book_append_sheet(wb, hoja(d.galardonados_sin_lista.map((n) => ({ 'Galardonado sin coincidencia en la nómina': n })), ['Galardonado sin coincidencia en la nómina'], [44]), 'Galardonados sin nómina');

      const ahora = new Date().toLocaleString('sv-SE', { timeZone: 'America/Guatemala' }).slice(0, 16).replace(' ', '_').replace(':', 'h');
      XLSX.writeFile(wb, `reporte_final_emetra_${ahora}.xlsx`);
      toast('Excel descargado');
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; b.textContent = 'Descargar Excel final'; }
  }

  // ---------------- Eventos ----------------
  function eventos() {
    $('fLogin').addEventListener('submit', ingresar);
    document.querySelectorAll('.jsSalir').forEach((b) => b.addEventListener('click', salir));
    ['click', 'input', 'touchstart', 'keydown'].forEach((t) => document.addEventListener(t, () => (huboActividad = true), { passive: true }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S) refrescar(true).catch(() => {}); });

    // encargado
    $('eArea').addEventListener('change', () => { abierto = null; pintarLista(); });
    $('eBuscar').addEventListener('input', pintarLista);
    botonLimpiar($('eBuscar'), () => { abierto = null; pintarLista(); });
    botonLimpiar($('aBuscar'), pintarAsistenciaAdm);
    $('eLista').addEventListener('click', clicLista);

    // admin
    $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) abrirTab(b.dataset.tab); });
    $('bSubirP').addEventListener('click', () => $('fPersonas').click());
    $('bSubirC').addEventListener('click', () => $('fConf').click());
    $('bSubirG').addEventListener('click', () => $('fGalard').click());
    $('fPersonas').addEventListener('change', (e) => subir(e.target, 'p'));
    $('fConf').addEventListener('change', (e) => subir(e.target, 'c'));
    $('fGalard').addEventListener('change', (e) => subir(e.target, 'g'));
    $('bExcel').addEventListener('click', descargar);
    $('aBuscar').addEventListener('input', pintarAsistenciaAdm);
    document.querySelectorAll('input[name=aFiltro]').forEach((r) => r.addEventListener('change', pintarAsistenciaAdm));
    $('aLista').addEventListener('click', accionAsisAdm);
    $('revLista').addEventListener('click', accionRevisar);
    $('revLista').addEventListener('input', buscarRevisar);
    $('revResueltos').addEventListener('click', accionRevisar);
    $('fEnc').addEventListener('submit', guardarEnc);
    $('bEncCancelar').addEventListener('click', limpiarFormEnc);
    $('encLista').addEventListener('click', accionEnc);
    $('bHistRef').addEventListener('click', cargarHistorial);
    $('fAjustes').addEventListener('submit', guardarAjustes);
    $('bBorrar').addEventListener('click', borrar);
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
