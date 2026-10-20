/* Panel Universal · plataforma: acceso, perfil y dashboards privados (Supabase).
   Usa globals del motor de dashboards (index.html): DATA, CURRENT_FILE, OV, load, readFile, snapshot, esc, $. */
(() => {
  const cfg = window.PANEL_CONFIG || {};
  const VIEWS = ['authView', 'homeView', 'editorView'];
  const MAX_BYTES = 25 * 1024 * 1024;

  const PL = window.PL = {
    user: null, profile: null, dashId: null, datasetId: null, dirty: false, recovering: false,
    newData() { PL.dashId = null; PL.datasetId = null; PL.dirty = true; if (CURRENT_FILE) $('#dTitle').value = baseName(CURRENT_FILE.name); setStatus('Sin guardar'); },
    detach() { PL.dashId = null; PL.datasetId = null; PL.dirty = true; setStatus('Sin guardar'); },
    markDirty() { if (!PL.dirty) { PL.dirty = true; setStatus('Cambios sin guardar'); } }
  };

  const baseName = n => n.replace(/\.[^.]+$/, '');
  const fmtDate = s => new Date(s).toLocaleString('es-CL', {dateStyle: 'medium', timeStyle: 'short'});
  const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  let toastT;
  const toast = t => { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2600); };
  const setStatus = t => { $('#saveStatus').textContent = t || ''; };
  const msg = (el, text, ok) => { el.hidden = !text; el.textContent = text || ''; el.classList.toggle('ok', !!ok); };

  function show(view) {
    VIEWS.forEach(v => $('#' + v).hidden = v !== view);
    $('#btnSample').hidden = view !== 'editorView';
    $('#btnPalette').hidden = !PL.user;
    $('#userBtn').hidden = !PL.user;
  }

  function tr(err) {
    const m = (err && err.message) || String(err), c = err && (err.code || err.status);
    if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
    if (/Email not confirmed/i.test(m)) return 'Confirma tu correo antes de entrar: revisa tu bandeja de entrada.';
    if (/Database error saving new user|solo por invitaci/i.test(m)) return 'Tu correo no tiene una invitación vigente. Pide una a un administrador.';
    if (/already registered/i.test(m)) return 'Ese correo ya tiene una cuenta. Inicia sesión.';
    if (c === 429 || /rate limit|over_email_send_rate_limit/i.test(m)) return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
    if (/same password/i.test(m)) return 'La nueva contraseña debe ser distinta de la actual.';
    if (/Password should be/i.test(m)) return 'La contraseña debe tener al menos 8 caracteres.';
    return m;
  }

  if (!cfg.supabaseUrl || !cfg.supabaseKey || typeof supabase === 'undefined') {
    show('authView'); msg($('#authMsg'), 'No se pudo conectar con el servicio. Recarga la página.');
    return;
  }
  const sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
  PL.sb = sb;

  /* ---------- Formulario de acceso ---------- */
  let mode = 'login';
  const emailWrap = () => $('#aEmail').closest('label');
  function setMode(m) {
    mode = m;
    const T = {
      login:   ['Iniciar sesión', 'Accede a tu espacio de trabajo.', 'Entrar'],
      signup:  ['Crear cuenta', 'Usa el mismo correo al que te llegó la invitación.', 'Crear cuenta'],
      reset:   ['Recuperar contraseña', 'Te enviaremos un enlace para elegir una nueva.', 'Enviar enlace'],
      recover: ['Nueva contraseña', 'Elige una contraseña nueva para tu cuenta.', 'Guardar contraseña']
    }[m];
    $('#authTitle').textContent = T[0]; $('#authSub').textContent = T[1]; $('#authGo').textContent = T[2];
    $('#fNameWrap').hidden = m !== 'signup';
    emailWrap().hidden = m === 'recover';
    $('#fPassWrap').hidden = m === 'reset';
    $('#aPass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('#toSignup').hidden = m !== 'login'; $('#toReset').hidden = m !== 'login'; $('#toLogin').hidden = m === 'login' || m === 'recover';
    msg($('#authMsg'), '');
  }
  $('#toSignup').onclick = () => setMode('signup');
  $('#toReset').onclick = () => setMode('reset');
  $('#toLogin').onclick = () => setMode('login');

  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#aEmail').value.trim().toLowerCase(), pass = $('#aPass').value, name = $('#aName').value.trim();
    const btn = $('#authGo'), label = btn.textContent;
    const needEmail = mode !== 'recover';
    if (needEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return msg($('#authMsg'), 'Escribe un correo válido.');
    if (mode !== 'reset' && pass.length < 8) return msg($('#authMsg'), 'La contraseña debe tener al menos 8 caracteres.');
    btn.disabled = true; btn.textContent = 'Un momento…'; msg($('#authMsg'), '');
    try {
      if (mode === 'login') {
        const {error} = await sb.auth.signInWithPassword({email, password: pass});
        if (error) throw error;
      } else if (mode === 'signup') {
        const {data, error} = await sb.auth.signUp({email, password: pass, options: {data: {full_name: name || email.split('@')[0]}, emailRedirectTo: location.origin + location.pathname}});
        if (error) throw error;
        if (!data.session) msg($('#authMsg'), 'Listo. Te enviamos un correo para confirmar tu cuenta; después podrás iniciar sesión.', true);
      } else if (mode === 'reset') {
        const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo: location.origin + location.pathname});
        if (error) throw error;
        msg($('#authMsg'), 'Si el correo tiene una cuenta, te enviamos un enlace para cambiar la contraseña.', true);
      } else if (mode === 'recover') {
        const {error} = await sb.auth.updateUser({password: pass});
        if (error) throw error;
        PL.recovering = false; toast('Contraseña actualizada');
        const {data} = await sb.auth.getSession(); if (data.session) await onSession(data.session, true);
      }
    } catch (err) { msg($('#authMsg'), tr(err)); }
    finally { btn.disabled = false; btn.textContent = label; if (mode === 'login' || mode === 'recover') $('#aPass').value = ''; }
  });

  /* ---------- Sesión ---------- */
  let routed = false;
  async function onSession(session, force) {
    if (PL.recovering) return;
    if (!force && PL.user && PL.user.id === session.user.id && PL.profile) return;
    PL.user = session.user;
    const {data: p, error} = await sb.from('profiles').select('*').eq('id', session.user.id).single();
    if (error || !p) { await sb.auth.signOut(); routed = true; PL.user = null; setMode('login'); show('authView'); return msg($('#authMsg'), 'No se encontró tu perfil. Contacta a un administrador.'); }
    if (p.status !== 'active') {
      await sb.auth.signOut(); PL.user = null; PL.profile = null; routed = true; setMode('login'); show('authView');
      return msg($('#authMsg'), 'Tu cuenta está suspendida. Contacta a un administrador.');
    }
    PL.profile = p; routed = true;
    const first = (p.full_name || p.email).split(' ')[0];
    $('#userBtn').innerHTML = `<span class="avatar">${esc(initials(p.full_name || p.email))}</span><span>${esc(first)}</span>`;
    sb.rpc('touch_last_seen').then(() => {});
    show('homeView'); loadList();
  }
  function onSignedOut() {
    PL.user = null; PL.profile = null; PL.dashId = null; PL.datasetId = null; PL.dirty = false; routed = true;
    setMode('login'); show('authView');
  }
  sb.auth.onAuthStateChange((event, session) => {
    // No se hacen llamadas a Supabase dentro del callback: se difieren para evitar bloqueos.
    if (event === 'PASSWORD_RECOVERY') { PL.recovering = true; setTimeout(() => { routed = true; setMode('recover'); show('authView'); }, 0); return; }
    if (event === 'SIGNED_OUT') { setTimeout(onSignedOut, 0); return; }
    if (event === 'INITIAL_SESSION' && !session) { setTimeout(() => { if (!PL.recovering) onSignedOut(); }, 0); return; }
    if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) setTimeout(() => onSession(session), 0);
  });
  setTimeout(() => { if (!routed) onSignedOut(); }, 4000);

  /* ---------- Mis dashboards ---------- */
  async function loadList() {
    const grid = $('#dashList');
    grid.innerHTML = '<div class="empty">Cargando…</div>';
    const {data, error} = await sb.from('dashboards').select('id,title,updated_at,datasets(name,row_count)')
      .eq('owner_id', PL.user.id).order('updated_at', {ascending: false});
    if (error) { grid.innerHTML = ''; return toast('No se pudo cargar la lista: ' + tr(error)); }
    $('#homeSub').textContent = data.length ? `${data.length} dashboard${data.length === 1 ? '' : 's'} privado${data.length === 1 ? '' : 's'}` : '';
    if (!data.length) {
      grid.innerHTML = '<div class="empty"><b>Aún no tienes dashboards.</b><br>Crea el primero subiendo un archivo CSV, Excel o JSON.<br><br><button class="btn primary" id="emptyNew">+ Nuevo dashboard</button></div>';
      $('#emptyNew').onclick = newDash; return;
    }
    grid.innerHTML = data.map(d => `<div class="card dcard" data-id="${d.id}" tabindex="0" role="button" aria-label="Abrir ${esc(d.title)}">
      <h4>${esc(d.title)}</h4>
      <div class="meta">${d.datasets ? esc(d.datasets.name) + ' · ' + fmt.format(d.datasets.row_count || 0) + ' filas' : 'Sin datos'}</div>
      <div class="meta">Actualizado ${esc(fmtDate(d.updated_at))}</div>
      <div class="row"><button class="btn sm" data-a="rename">Renombrar</button><button class="btn sm" data-a="del">Eliminar</button></div></div>`).join('');
  }
  $('#dashList').addEventListener('click', e => {
    const card = e.target.closest('.dcard'); if (!card) return;
    const id = card.dataset.id, a = e.target.closest('[data-a]');
    if (a) { e.stopPropagation(); return a.dataset.a === 'rename' ? renameDash(id) : deleteDash(id); }
    openDash(id);
  });
  $('#dashList').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('dcard')) openDash(e.target.dataset.id); });

  function newDash() {
    PL.dashId = null; PL.datasetId = null; PL.dirty = false; CURRENT_FILE = null;
    $('#app').hidden = true; $('#dropSec').hidden = false; $('#file').value = ''; $('#err').hidden = true;
    $('#dTitle').value = ''; setStatus(''); show('editorView');
  }
  $('#btnNewDash').onclick = newDash;

  async function openDash(id) {
    toast('Abriendo dashboard…');
    try {
      const {data: d, error} = await sb.from('dashboards').select('*, datasets(*)').eq('id', id).single();
      if (error) throw error;
      if (!d.datasets) throw new Error('Este dashboard no tiene datos asociados.');
      const {data: blob, error: e2} = await sb.storage.from('datasets').download(d.datasets.storage_path);
      if (e2) throw e2;
      const file = new File([blob], d.datasets.name);
      const raw = await readFile(file);
      OV = (d.config && d.config.ov) || {};
      CURRENT_FILE = file;
      PL.dashId = d.id; PL.datasetId = d.dataset_id;
      show('editorView');
      load(raw, d.datasets.name, {cfg: d.config || {}});
      $('#dTitle').value = d.title; PL.dirty = false; setStatus('Guardado ' + fmtDate(d.updated_at));
    } catch (err) { toast('No se pudo abrir: ' + tr(err)); show('homeView'); }
  }

  async function renameDash(id) {
    const cur = (document.querySelector(`.dcard[data-id="${id}"] h4`) || {}).textContent || '';
    const t = prompt('Nuevo nombre del dashboard:', cur);
    if (t === null || !t.trim()) return;
    const {error} = await sb.from('dashboards').update({title: t.trim().slice(0, 120)}).eq('id', id);
    if (error) return toast('No se pudo renombrar: ' + tr(error));
    loadList();
  }

  async function deleteDash(id) {
    if (!confirm('¿Eliminar este dashboard? Esta acción no se puede deshacer.')) return;
    const {data: d} = await sb.from('dashboards').select('dataset_id, datasets(storage_path)').eq('id', id).single();
    const {error} = await sb.from('dashboards').delete().eq('id', id);
    if (error) return toast('No se pudo eliminar: ' + tr(error));
    if (d && d.dataset_id) {
      const {count} = await sb.from('dashboards').select('id', {count: 'exact', head: true}).eq('dataset_id', d.dataset_id);
      if (!count && d.datasets) { await sb.storage.from('datasets').remove([d.datasets.storage_path]); await sb.from('datasets').delete().eq('id', d.dataset_id); }
    }
    toast('Dashboard eliminado'); loadList();
  }

  /* ---------- Editor: guardar ---------- */
  const safeName = n => n.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-]+/g, '_').slice(-80);
  async function save() {
    if ($('#app').hidden || !DATA.rows.length) return toast('Primero carga un archivo con datos.');
    const btn = $('#btnSaveCloud'); btn.disabled = true; setStatus('Guardando…');
    try {
      let datasetId = PL.datasetId;
      if (!datasetId) {
        const file = CURRENT_FILE;
        if (!file) throw new Error('No se encontró el archivo original.');
        if (file.size > MAX_BYTES) throw new Error('El archivo supera el máximo de 25 MB.');
        const path = `${PL.user.id}/${crypto.randomUUID()}-${safeName(file.name)}`;
        const up = await sb.storage.from('datasets').upload(path, file, {contentType: file.type || 'application/octet-stream', upsert: false});
        if (up.error) throw up.error;
        const ins = await sb.from('datasets').insert({
          owner_id: PL.user.id, name: file.name, storage_path: path,
          columns: DATA.cols.map(({key, type}) => ({key, type})), row_count: DATA.rows.length, size_bytes: file.size
        }).select('id').single();
        if (ins.error) { await sb.storage.from('datasets').remove([path]); throw ins.error; }
        datasetId = ins.data.id; PL.datasetId = datasetId;
      }
      const payload = {title: ($('#dTitle').value.trim() || 'Dashboard sin título').slice(0, 120), dataset_id: datasetId, config: snapshot()};
      if (PL.dashId) {
        const r = await sb.from('dashboards').update(payload).eq('id', PL.dashId).select('updated_at').single();
        if (r.error) throw r.error;
      } else {
        const r = await sb.from('dashboards').insert({owner_id: PL.user.id, ...payload}).select('id,updated_at').single();
        if (r.error) throw r.error;
        PL.dashId = r.data.id;
      }
      PL.dirty = false; setStatus('Guardado ' + new Date().toLocaleTimeString('es-CL', {hour: '2-digit', minute: '2-digit'})); toast('Dashboard guardado');
    } catch (err) { setStatus('Error al guardar'); toast('No se pudo guardar: ' + tr(err)); }
    finally { btn.disabled = false; }
  }
  $('#btnSaveCloud').onclick = save;
  $('#dTitle').addEventListener('input', () => PL.markDirty());
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !$('#editorView').hidden) { e.preventDefault(); save(); } });
  $('#btnBack').onclick = () => {
    if (PL.dirty && !$('#app').hidden && !confirm('Tienes cambios sin guardar. ¿Salir igual?')) return;
    PL.dirty = false; show('homeView'); loadList();
  };
  window.addEventListener('beforeunload', e => { if (PL.dirty && PL.user && !$('#editorView').hidden && !$('#app').hidden) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- Perfil ---------- */
  $('#userBtn').onclick = () => {
    const p = PL.profile; if (!p) return;
    $('#pName').value = p.full_name || ''; $('#pEmail').value = p.email;
    $('#pRole').textContent = p.role === 'admin' ? 'Administrador' : 'Miembro';
    msg($('#profMsg'), ''); msg($('#passMsg'), ''); $('#pPass').value = '';
    $('#dlgProfile').showModal();
  };
  $('#profForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#pName').value.trim().slice(0, 80);
    const {error} = await sb.from('profiles').update({full_name: name || null}).eq('id', PL.user.id);
    if (error) return msg($('#profMsg'), tr(error));
    PL.profile.full_name = name || null;
    $('#userBtn').innerHTML = `<span class="avatar">${esc(initials(name || PL.profile.email))}</span><span>${esc((name || PL.profile.email).split(' ')[0])}</span>`;
    msg($('#profMsg'), 'Perfil actualizado', true);
  });
  $('#passForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pass = $('#pPass').value;
    if (pass.length < 8) return msg($('#passMsg'), 'La contraseña debe tener al menos 8 caracteres.');
    const {error} = await sb.auth.updateUser({password: pass});
    if (error) return msg($('#passMsg'), tr(error));
    $('#pPass').value = ''; msg($('#passMsg'), 'Contraseña actualizada', true);
  });
  $('#btnLogout').onclick = async () => { $('#dlgProfile').close(); PL.dirty = false; await sb.auth.signOut(); };

  setMode('login');
})();
