/* Panel Universal · panel de administración (solo administradores).
   Toda la seguridad está en el servidor: las funciones admin_* y las políticas RLS rechazan a quien no sea administrador.
   Aquí solo se dibuja la pantalla. Usa PL (platform.js): sb, user, profile, show, toast, tr, goHome. */
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[m]));
  const dt = s => s ? new Date(s).toLocaleString('es-CL', {dateStyle: 'medium', timeStyle: 'short'}) : '—';
  const nf = new Intl.NumberFormat('es-CL');
  const ROLE = {admin: 'Administrador', member: 'Miembro'};
  const isAdmin = () => !!(PL.profile && PL.profile.role === 'admin');
  const siteUrl = () => location.origin + location.pathname;

  let tab = 'users', users = [], invs = [], logs = [], q = '';
  const byId = () => Object.fromEntries(users.map(u => [u.id, u]));
  const name = u => u ? (u.full_name || u.email) : null;

  /* ---------- Carga ---------- */
  async function load() {
    const [u, i, a] = await Promise.all([
      PL.sb.rpc('admin_overview'),
      PL.sb.from('invitations').select('*').order('created_at', {ascending: false}),
      PL.sb.from('audit_log').select('*').order('created_at', {ascending: false}).limit(100)
    ]);
    const err = u.error || i.error || a.error;
    if (err) { PL.toast('No se pudo cargar el panel: ' + PL.tr(err)); return false; }
    users = u.data || []; invs = i.data || []; logs = a.data || [];
    return true;
  }
  const invStatus = v => v.accepted_at ? 'accepted' : (new Date(v.expires_at) < new Date() ? 'expired' : 'pending');

  /* ---------- Resumen ---------- */
  function renderStats() {
    const act = users.filter(u => u.status === 'active').length;
    const cards = [
      ['Usuarios', users.length, `${act} activos`],
      ['Administradores', users.filter(u => u.role === 'admin' && u.status === 'active').length, 'activos'],
      ['Suspendidos', users.filter(u => u.status === 'suspended').length, 'sin acceso'],
      ['Invitaciones pendientes', invs.filter(v => invStatus(v) === 'pending').length, 'por aceptar'],
      ['Dashboards', users.reduce((s, u) => s + Number(u.dashboards || 0), 0), 'en total'],
      ['Archivos de datos', users.reduce((s, u) => s + Number(u.datasets || 0), 0), 'subidos']
    ];
    $('#admStats').innerHTML = cards.map(c => `<div class="kpi"><div class="l">${esc(c[0])}</div><div class="v">${nf.format(c[1])}</div><div class="s"><span>${esc(c[2])}</span></div></div>`).join('');
  }

  /* ---------- Pestaña: Usuarios ---------- */
  function renderUsers() {
    $('#admBody').innerHTML = `<div class="tablebox"><div class="tbar"><input type="search" id="admQ" placeholder="Buscar por nombre o correo…" aria-label="Buscar usuarios" value="${esc(q)}"><span class="chip" id="admCount"></span></div><div class="tscroll"><table id="admUsers"></table></div></div>
      <p class="hint">Suspender a una persona le quita el acceso a sus dashboards, a sus archivos y al asistente de inmediato; no borra nada y se puede revertir. Los administradores no ven el contenido de los dashboards privados de otras personas.</p>`;
    fillUsers();
  }
  function fillUsers() {
    const t = q.trim().toLowerCase();
    const rows = users.filter(u => !t || `${u.email} ${u.full_name || ''}`.toLowerCase().includes(t));
    $('#admCount').textContent = `${rows.length} de ${users.length}`;
    $('#admUsers').innerHTML = '<thead><tr><th>Persona</th><th>Rol</th><th>Estado</th><th>Registro</th><th>Último acceso</th><th>Dashboards</th><th>Archivos</th><th>Acciones</th></tr></thead><tbody>' +
      (rows.length ? rows.map(u => {
        const me = u.id === PL.user.id, susp = u.status === 'suspended';
        return `<tr data-id="${u.id}"><td><b>${esc(u.full_name || u.email)}</b>${me ? ' <span class="pill">tú</span>' : ''}<br><span class="hint">${esc(u.email)}</span></td>
          <td><select data-a="role" aria-label="Rol de ${esc(u.email)}"><option value="member"${u.role === 'member' ? ' selected' : ''}>Miembro</option><option value="admin"${u.role === 'admin' ? ' selected' : ''}>Administrador</option></select></td>
          <td><span class="pill ${susp ? 'bad' : 'ok'}">${susp ? 'Suspendido' : 'Activo'}</span></td>
          <td>${esc(dt(u.created_at))}</td><td>${esc(dt(u.last_seen_at))}</td>
          <td class="n">${nf.format(u.dashboards || 0)}</td><td class="n">${nf.format(u.datasets || 0)}</td>
          <td><button class="btn sm" data-a="status" data-to="${susp ? 'active' : 'suspended'}"${me ? ' disabled title="No puedes suspender tu propia cuenta"' : ''}>${susp ? 'Reactivar' : 'Suspender'}</button></td></tr>`;
      }).join('') : '<tr><td colspan="8" class="hint">Ningún usuario coincide con la búsqueda.</td></tr>') + '</tbody>';
  }
  async function setRole(id, role, sel) {
    const u = users.find(x => x.id === id); if (!u || u.role === role) return;
    const ok = role === 'admin' ? confirm(`¿Dar permisos de administrador a ${u.email}?\n\nPodrá invitar, suspender y cambiar roles de cualquier persona.`) : confirm(`¿Quitar los permisos de administrador a ${u.email}?`);
    if (!ok) { sel.value = u.role; return; }
    const {error} = await PL.sb.rpc('admin_set_role', {p_user: id, p_role: role});
    if (error) { sel.value = u.role; return PL.toast(PL.tr(error)); }
    PL.toast('Rol actualizado'); refresh();
  }
  async function setStatus(id, to) {
    const u = users.find(x => x.id === id); if (!u) return;
    const msg = to === 'suspended' ? `¿Suspender a ${u.email}?\n\nPerderá el acceso de inmediato. Sus datos se conservan y puedes reactivarla cuando quieras.` : `¿Reactivar a ${u.email}?`;
    if (!confirm(msg)) return;
    const {error} = await PL.sb.rpc('admin_set_status', {p_user: id, p_status: to});
    if (error) return PL.toast(PL.tr(error));
    PL.toast(to === 'suspended' ? 'Usuario suspendido' : 'Usuario reactivado'); refresh();
  }

  /* ---------- Pestaña: Invitaciones ---------- */
  const inviteText = v => `Hola, te invito a usar Panel Universal, una plataforma para subir tus datos y ver gráficos automáticos.\n\nPara crear tu cuenta:\n1. Entra a ${siteUrl()}\n2. Haz clic en "Tengo una invitación: crear cuenta".\n3. Regístrate con este mismo correo (${v.email}) y elige tu contraseña (mínimo 8 caracteres).\n4. Confirma el correo de verificación que te llegará e inicia sesión.\n\nLa invitación es válida hasta el ${new Date(v.expires_at).toLocaleDateString('es-CL', {dateStyle: 'long'})}.`;
  function renderInvites() {
    $('#admBody').innerHTML = `<form class="admform" id="admInv" novalidate>
        <label>Correo de la persona<input type="email" id="invEmail" placeholder="persona@empresa.cl" autocomplete="off"></label>
        <label>Rol<select id="invRole"><option value="member">Miembro</option><option value="admin">Administrador</option></select></label>
        <button class="btn primary" type="submit">Invitar</button>
        <div class="msg" id="invMsg" hidden style="flex-basis:100%;margin:0"></div>
      </form>
      <div class="tablebox"><div class="tscroll"><table id="admInvites"></table></div></div>
      <p class="hint">La invitación autoriza ese correo a crear una cuenta durante 14 días; no envía ningún correo por sí sola. Usa "Copiar mensaje" y pégalo en un correo o chat. La persona debe registrarse con exactamente el mismo correo.</p>`;
    $('#admInvites').innerHTML = '<thead><tr><th>Correo</th><th>Rol</th><th>Estado</th><th>Creada</th><th>Vence</th><th>Acciones</th></tr></thead><tbody>' +
      (invs.length ? invs.map(v => {
        const st = invStatus(v), pill = st === 'accepted' ? '<span class="pill ok">Aceptada</span>' : st === 'expired' ? '<span class="pill warn">Vencida</span>' : '<span class="pill">Pendiente</span>';
        const acts = st === 'accepted' ? '<span class="hint">Cuenta creada</span>'
          : `<button class="btn sm" data-a="copy">Copiar mensaje</button><button class="btn sm" data-a="renew">${st === 'expired' ? 'Renovar' : 'Extender'}</button><button class="btn sm" data-a="revoke">Revocar</button>`;
        return `<tr data-id="${v.id}" data-email="${esc(v.email)}" data-role="${v.role}"><td><b>${esc(v.email)}</b></td><td>${esc(ROLE[v.role] || v.role)}</td><td>${pill}</td><td>${esc(dt(v.created_at))}</td><td>${esc(dt(v.expires_at))}</td><td>${acts}</td></tr>`;
      }).join('') : '<tr><td colspan="6" class="hint">Aún no hay invitaciones.</td></tr>') + '</tbody>';
  }
  const copy = text => (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => PL.toast('Mensaje copiado'), () => { prompt('Copia el mensaje (Ctrl+C):', text); });
  async function invite(email, role, msgEl) {
    const {error} = await PL.sb.rpc('admin_invite', {p_email: email, p_role: role});
    if (error) { if (msgEl) { msgEl.hidden = false; msgEl.classList.remove('ok'); msgEl.textContent = PL.tr(error); } else PL.toast(PL.tr(error)); return false; }
    await refresh(); return true;
  }

  /* ---------- Pestaña: Actividad ---------- */
  function describe(l) {
    const U = byId(), m = l.meta || {}, who = id => name(U[id]);
    switch (l.action) {
      case 'user.invite': return `Invitó a ${m.email || 'una persona'} como ${ROLE[m.role] || m.role || 'miembro'}`;
      case 'user.invite_revoke': return 'Revocó una invitación';
      case 'user.set_role': return `Cambió el rol de ${who(l.target_id) || 'un usuario'} a ${ROLE[m.role] || m.role}`;
      case 'user.set_status': return `${m.status === 'suspended' ? 'Suspendió' : 'Reactivó'} a ${who(l.target_id) || 'un usuario'}`;
      case 'dashboard.share': return `Compartió un dashboard con ${who(m.user) || 'un usuario'} (${m.permission === 'edit' ? 'puede editar' : 'solo lectura'})`;
      case 'dashboard.publish': return 'Publicó un dashboard con enlace público';
      case 'dashboard.unpublish': return 'Dejó de publicar un dashboard';
      default: return l.action;
    }
  }
  function renderActivity() {
    const U = byId();
    $('#admBody').innerHTML = `<div class="tablebox"><div class="tscroll"><table><thead><tr><th>Cuándo</th><th>Quién</th><th>Qué hizo</th></tr></thead><tbody>` +
      (logs.length ? logs.map(l => `<tr><td>${esc(dt(l.created_at))}</td><td>${esc(name(U[l.actor_id]) || '—')}</td><td>${esc(describe(l))}</td></tr>`).join('') : '<tr><td colspan="3" class="hint">Aún no hay actividad registrada.</td></tr>') +
      `</tbody></table></div></div><p class="hint">Se muestran las últimas 100 acciones sensibles: invitaciones, cambios de rol, suspensiones, accesos compartidos y publicaciones.</p>`;
  }

  /* ---------- Navegación y eventos ---------- */
  function render() {
    document.querySelectorAll('#admTabs .tab').forEach(b => { const on = b.dataset.t === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    renderStats();
    ({users: renderUsers, invites: renderInvites, activity: renderActivity})[tab]();
  }
  async function refresh() { if (await load()) render(); }
  async function open() {
    if (!isAdmin()) return;
    PL.show('adminView');
    $('#admBody').innerHTML = '<div class="empty">Cargando…</div>';
    await refresh();
  }
  PL.openAdmin = open;

  $('#admTabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) { tab = b.dataset.t; render(); } });
  $('#admBack').onclick = () => PL.goHome();
  $('#admRefresh').onclick = () => refresh().then(() => PL.toast('Panel actualizado'));
  $('#admBody').addEventListener('input', e => { if (e.target.id === 'admQ') { q = e.target.value; fillUsers(); } });
  $('#admBody').addEventListener('change', e => {
    const sel = e.target.closest('[data-a="role"]'); if (sel) setRole(sel.closest('tr').dataset.id, sel.value, sel);
  });
  $('#admBody').addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b || b.tagName === 'SELECT') return;
    const tr = b.closest('tr'); if (!tr) return;
    if (b.dataset.a === 'status') return setStatus(tr.dataset.id, b.dataset.to);
    const v = invs.find(x => x.id === tr.dataset.id);
    if (b.dataset.a === 'copy' && v) return copy(inviteText(v));
    if (b.dataset.a === 'renew') { if (await invite(tr.dataset.email, tr.dataset.role)) PL.toast('Invitación renovada por 14 días'); return; }
    if (b.dataset.a === 'revoke') {
      if (!confirm(`¿Revocar la invitación de ${tr.dataset.email}?`)) return;
      const {error} = await PL.sb.rpc('admin_revoke_invitation', {p_id: tr.dataset.id});
      if (error) return PL.toast(PL.tr(error));
      PL.toast('Invitación revocada'); refresh();
    }
  });
  $('#admBody').addEventListener('submit', async e => {
    if (e.target.id !== 'admInv') return; e.preventDefault();
    const email = $('#invEmail').value.trim().toLowerCase(), msg = $('#invMsg');
    msg.hidden = true;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.hidden = false; msg.classList.remove('ok'); msg.textContent = 'Escribe un correo válido.'; return; }
    const role = $('#invRole').value;
    if (await invite(email, role, msg)) {
      PL.toast(`Invitación registrada para ${email}`);
      const m = $('#invMsg'); if (m) { m.hidden = false; m.classList.add('ok'); m.textContent = `Listo: ${email} puede crear su cuenta durante 14 días. Usa "Copiar mensaje" para avisarle.`; }
    }
  });
  if (Array.isArray(window.COMMANDS)) COMMANDS.push(['Abrir panel de administración', () => { if (isAdmin()) open(); }]);
})();
