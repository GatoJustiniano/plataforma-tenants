// Vistas del panel. Cada una pinta en #vista y puede devolver una función de limpieza.
const V = () => document.getElementById('vista');
const ACTIVAS = ['pendiente', 'en_curso'];

const Vistas = {
  // ---------------------------------------------------------------- Inicio
  async inicio() {
    const [tenants, ops] = await Promise.all([api('/tenants'), api('/operaciones?limite=8')]);
    const cuenta = (e) => tenants.filter((t) => t.estado === e).length;
    const enCurso = tenants.filter((t) => CLASE_ESTADO[t.estado] === 'curso').length;
    V().innerHTML = `
      <div class="cabecera"><div><h1>Inicio</h1><p class="muted">Estado general de la plataforma de tenants.</p></div></div>
      <div class="grid g4">
        ${[['Tenants', tenants.length], ['Activos', cuenta('activo')], ['Suspendidos', cuenta('suspendido')], ['Con fallos', cuenta('fallido')]]
          .map(([t, n]) => `<div class="tarjeta kpi"><strong>${n}</strong><span>${t}</span></div>`).join('')}
      </div>
      ${enCurso ? `<div class="nota" style="margin-top:16px">${enCurso} tenant(s) con una operación en curso.</div>` : ''}
      <div class="tarjeta" style="margin-top:16px">
        <h2>Operaciones recientes</h2>
        ${tablaOperaciones(ops, { conTenant: true })}
      </div>`;
  },

  // ---------------------------------------------------------------- Tenants
  async tenants() {
    const { planes } = await api('/planes');
    V().innerHTML = `
      <div class="cabecera">
        <div><h1>Tenants</h1><p class="muted">Instituciones registradas y el estado de sus servicios.</p></div>
        <a class="boton primario" href="#/tenants/nuevo">+ Crear tenant</a>
      </div>
      <div class="tarjeta">
        <div class="filtros">
          <input id="f-nombre" placeholder="Buscar por nombre o identificador">
          <select id="f-estado"><option value="">Todos los estados</option>
            ${['aprovisionando', 'activo', 'suspendido', 'fallido', 'eliminando', 'eliminado'].map((e) => `<option>${e}</option>`).join('')}</select>
          <select id="f-plan"><option value="">Todos los planes</option>${planes.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select>
          <select id="f-entorno"><option value="">Todos los entornos</option>${Object.entries(ENTORNOS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        </div>
        <div id="lista"></div>
      </div>`;
    const nombrePlan = Object.fromEntries(planes.map((p) => [p.id, p.nombre]));
    const cargar = async () => {
      const q = new URLSearchParams();
      for (const k of ['nombre', 'estado', 'plan', 'entorno']) { const v = document.getElementById(`f-${k}`).value; if (v) q.set(k, v); }
      const lista = await api(`/tenants?${q}`);
      document.getElementById('lista').innerHTML = lista.length ? `
        <table><thead><tr><th>Institución</th><th>Plan</th><th>Entorno</th><th>Motor</th><th>Estado</th><th>URL</th><th>Actualizado</th></tr></thead>
        <tbody>${lista.map((t) => `
          <tr class="clic" data-id="${esc(t.id)}">
            <td><strong>${esc(t.nombre)}</strong><br><small class="muted mono">${esc(t.id)}</small></td>
            <td>${esc(nombrePlan[t.plan] || t.plan)}</td><td>${esc(ENTORNOS[t.entorno] || t.entorno)}</td>
            <td>${esc(MOTORES[t.motor]?.nombre || t.motor)}</td><td>${badge(t.estado)}</td>
            <td>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.url.replace('http://', ''))}</a>` : '<span class="muted">—</span>'}</td>
            <td><small>${fecha(t.actualizado_en)}</small></td>
          </tr>`).join('')}</tbody></table>`
        : '<div class="vacio">No hay tenants con esos filtros. <a href="#/tenants/nuevo">Crear el primero</a></div>';
      document.querySelectorAll('#lista tr.clic').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/tenants/${tr.dataset.id}`; }));
    };
    let t;
    document.getElementById('f-nombre').addEventListener('input', () => { clearTimeout(t); t = setTimeout(cargar, 250); });
    ['estado', 'plan', 'entorno'].forEach((k) => document.getElementById(`f-${k}`).addEventListener('change', cargar));
    await cargar();
  },

  // ---------------------------------------------------------------- Crear tenant (wizard)
  async crear() {
    const { planes } = await api('/planes');
    const d = { nombre: '', id: '', idEditado: false, contacto_email: '', entorno: 'dev', plan: planes[1]?.id || planes[0].id, motor: 'terraform' };
    let paso = 1;
    const plan = () => planes.find((p) => p.id === d.plan);
    const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');

    const pasos = () => `<div class="pasos">${['Datos y plan', 'Configuración', 'Revisión'].map((n, i) => `
      ${i ? '<div class="paso-linea"></div>' : ''}
      <div class="paso ${i + 1 === paso ? 'actual' : i + 1 < paso ? 'hecho' : ''}"><span class="n">${i + 1 < paso ? '✓' : i + 1}</span>${n}</div>`).join('')}</div>`;

    const tarjetasPlan = () => `<div class="grid g3">${planes.map((p) => `
      <div class="plan ${p.id === d.plan ? 'sel' : ''}" data-plan="${p.id}">
        ${p.id === d.plan ? '<span class="etiqueta">SELECCIONADO</span>' : ''}
        <h3>${esc(p.nombre)}</h3><small class="muted">${esc(p.descripcion)}</small>
        <ul><li>Hasta ${num(p.limites.estudiantes)} estudiantes</li><li>Base de datos: ${p.infra.data_volume_gb} GB</li>
          <li>${esc(p.infra.instance_type)} · ${p.infra.memoria_gib} GiB RAM</li></ul>
        <div class="precio">${usd(p.costo_estimado.activo_mes)}</div>
      </div>`).join('')}</div>`;

    const resumen = () => {
      const p = plan();
      return `<div class="tarjeta resumen">
        <h2>Resumen del tenant</h2><p class="muted"><small>Se aprovisionará al confirmar.</small></p>
        <dl>
          <dt>Institución</dt><dd><strong>${esc(d.nombre || '—')}</strong><br><small class="muted mono">${esc(d.id || '—')}</small></dd>
          <dt>Plan seleccionado</dt><dd>${esc(p.nombre)} · ${usd(p.costo_estimado.activo_mes)}</dd>
          <dt>Entorno y región</dt><dd>${esc(ENTORNOS[d.entorno])} · us-east-1</dd>
          <dt>Motor de IaC</dt><dd>${esc(MOTORES[d.motor].nombre)}</dd>
        </dl>
        <h3 style="margin-top:14px">Recursos incluidos</h3>
        <ul class="lista-puntos"><li>Frontend y API (${esc(p.infra.instance_type)})</li><li>Base de datos aislada (${p.infra.data_volume_gb} GB cifrado)</li>
          <li>Secretos en SSM</li><li>Monitoreo en Grafana</li></ul>
        <div class="nota ok"><small>Los datos de este tenant quedan separados de otras instituciones: EC2, disco y Security Group propios.</small></div>
        <div class="nota" style="margin-top:10px"><small>La creación tarda unos minutos. Podrás seguir el progreso desde Tenants.</small></div>
      </div>`;
    };

    const cuerpo = () => {
      const p = plan();
      if (paso === 1) return `
        <div class="tarjeta">
          <h2>Datos de la institución</h2><p class="muted"><small>Identifica al tenant y configura su primer entorno.</small></p>
          <div class="grid g2" style="margin-top:12px">
            <div class="campo"><label>Nombre de la institución <span class="req">*</span></label><input id="c-nombre" value="${esc(d.nombre)}" placeholder="Instituto San Marcos"><div class="error-campo" id="e-nombre"></div></div>
            <div class="campo"><label>Identificador del tenant <span class="req">*</span></label><div class="sufijo"><input id="c-id" class="mono" value="${esc(d.id)}" placeholder="san-marcos"><span>.escuelas.app</span></div><div class="error-campo" id="e-id"></div></div>
            <div class="campo"><label>Correo del administrador <span class="req">*</span></label><input id="c-email" type="email" value="${esc(d.contacto_email)}" placeholder="admin@institucion.edu"><div class="error-campo" id="e-email"></div></div>
            <div class="campo"><label>Entorno</label><select id="c-entorno">${Object.entries(ENTORNOS).map(([k, v]) => `<option value="${k}" ${k === d.entorno ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          </div>
          <h2 style="margin-top:8px">Selecciona un plan</h2><p class="muted"><small>El plan define la capacidad y los límites iniciales del tenant.</small></p>
          <div id="planes" style="margin-top:12px">${tarjetasPlan()}</div>
        </div>`;
      if (paso === 2) return `
        <div class="tarjeta">
          <h2>Motor de infraestructura</h2><p class="muted"><small>Elige la herramienta que aprovisionará los recursos de este tenant (RF-08).</small></p>
          <div class="grid g2" style="margin-top:12px">${Object.entries(MOTORES).map(([k, m]) => `
            <label class="plan ${k === d.motor ? 'sel' : ''}" style="${m.listo ? '' : 'opacity:.55;cursor:not-allowed'}">
              <input type="radio" name="motor" value="${k}" ${k === d.motor ? 'checked' : ''} ${m.listo ? '' : 'disabled'} style="width:auto;margin-right:8px">
              <strong>${m.nombre}</strong> ${m.listo ? '' : '<span class="badge">próximamente</span>'}
              <div class="ayuda">${{ terraform: 'Motor principal. Estado en S3 con bloqueo.', opentofu: 'Mismo código HCL que Terraform, binario abierto.', pulumi: 'Implementación reducida en TypeScript.', cloudformation: 'Implementación reducida con stacks de AWS.' }[k]}</div>
            </label>`).join('')}</div>
        </div>
        <div class="tarjeta">
          <h2>Recursos que se crearán</h2>
          <table><tbody>
            <tr><td>Instancia EC2</td><td>${esc(p.infra.instance_type)} · ${p.infra.vcpu} vCPU · ${p.infra.memoria_gib} GiB</td></tr>
            <tr><td>Volumen de datos (SQLite)</td><td>${p.infra.data_volume_gb} GB gp3 cifrado</td></tr>
            <tr><td>Disco del sistema</td><td>${p.infra.root_volume_gb} GB gp3 cifrado</td></tr>
            <tr><td>Red</td><td>Security Group propio en la VPC compartida</td></tr>
            <tr><td>Secretos</td><td>Clave del panel docente en SSM (SecureString)</td></tr>
            <tr><td>Límites de uso</td><td>${num(p.limites.estudiantes)} estudiantes · ${num(p.limites.docentes)} docentes · ${num(p.limites.cursos)} cursos</td></tr>
          </tbody></table>
        </div>`;
      return `
        <div class="tarjeta">
          <h2>Revisión</h2><p class="muted"><small>Comprueba los datos antes de aprovisionar.</small></p>
          <table><tbody>
            <tr><td class="muted">Institución</td><td><strong>${esc(d.nombre)}</strong></td></tr>
            <tr><td class="muted">Identificador</td><td class="mono">${esc(d.id)}</td></tr>
            <tr><td class="muted">Correo del administrador</td><td>${esc(d.contacto_email)}</td></tr>
            <tr><td class="muted">Entorno</td><td>${esc(ENTORNOS[d.entorno])}</td></tr>
            <tr><td class="muted">Plan</td><td>${esc(p.nombre)} — ${usd(p.costo_estimado.activo_mes)} activo, ${usd(p.costo_estimado.suspendido_mes)} suspendido</td></tr>
            <tr><td class="muted">Motor</td><td>${esc(MOTORES[d.motor].nombre)}</td></tr>
            <tr><td class="muted">Retención si se suspende</td><td>${p.operacion.retencion_suspendido_dias} días</td></tr>
          </tbody></table>
          <div class="error-campo" id="e-crear" style="margin-top:10px"></div>
        </div>`;
    };

    const pintar = () => {
      V().innerHTML = `
        <div class="cabecera"><div><h1>Crear tenant</h1><p class="muted">Configura una nueva institución y prepara su entorno de registro de asistencia.</p></div></div>
        <small class="muted">PASO ${paso} DE 3</small>${pasos()}
        <div class="lado"><div>${cuerpo()}</div><div id="resumen">${resumen()}</div></div>
        <div class="pie"><small class="muted">Los recursos se crean según el plan seleccionado.</small>
          <div class="acciones"><button class="boton" id="b-atras">${paso === 1 ? 'Cancelar' : 'Atrás'}</button>
          <button class="boton primario" id="b-sig">${paso === 3 ? 'Crear tenant' : 'Continuar →'}</button></div></div>`;
      enlazar();
    };
    const refrescarResumen = () => { document.getElementById('resumen').innerHTML = resumen(); };

    const enlazar = () => {
      if (paso === 1) {
        const nombre = document.getElementById('c-nombre'); const id = document.getElementById('c-id');
        nombre.addEventListener('input', () => { d.nombre = nombre.value; if (!d.idEditado) { d.id = slug(d.nombre); id.value = d.id; } refrescarResumen(); });
        id.addEventListener('input', () => { d.idEditado = true; d.id = id.value.trim().toLowerCase(); refrescarResumen(); });
        document.getElementById('c-email').addEventListener('input', (e) => { d.contacto_email = e.target.value.trim(); });
        // El error de un campo desaparece en cuanto el usuario lo corrige
        [['c-nombre', 'e-nombre'], ['c-id', 'e-id'], ['c-email', 'e-email']].forEach(([c, e]) =>
          document.getElementById(c).addEventListener('input', () => {
            document.getElementById(e).textContent = '';
            if (c === 'c-nombre' && !d.idEditado) document.getElementById('e-id').textContent = '';
          }));
        document.getElementById('c-entorno').addEventListener('change', (e) => { d.entorno = e.target.value; refrescarResumen(); });
        const enlazarPlanes = () => document.querySelectorAll('#planes .plan').forEach((el) => el.addEventListener('click', () => {
          d.plan = el.dataset.plan; document.getElementById('planes').innerHTML = tarjetasPlan(); enlazarPlanes(); refrescarResumen();
        }));
        enlazarPlanes();
      }
      if (paso === 2) {
        document.querySelectorAll('input[name=motor]').forEach((r) => r.addEventListener('change', () => { d.motor = r.value; pintar(); }));
      }
      document.getElementById('b-atras').addEventListener('click', () => { if (paso === 1) location.hash = '#/tenants'; else { paso--; pintar(); } });
      document.getElementById('b-sig').addEventListener('click', siguiente);
    };

    const validar = () => {
      const errores = {
        nombre: d.nombre.trim().length < 3 ? 'Escribe el nombre de la institución' : '',
        id: !/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(d.id) ? '3 a 30 caracteres: minúsculas, números y guiones' : '',
        email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.contacto_email) ? 'Correo inválido' : '',
      };
      for (const [k, v] of Object.entries(errores)) document.getElementById(`e-${k}`).textContent = v;
      return !Object.values(errores).some(Boolean);
    };

    const siguiente = async () => {
      if (paso === 1 && !validar()) return;
      if (paso < 3) { paso++; pintar(); return; }
      const boton = document.getElementById('b-sig');
      boton.disabled = true; boton.textContent = 'Creando…';
      try {
        const r = await api('/tenants', { metodo: 'POST', cuerpo: {
          id: d.id, nombre: d.nombre.trim(), contacto_email: d.contacto_email, entorno: d.entorno, plan: d.plan, motor: d.motor } });
        avisar(`Tenant ${d.id} en cola de aprovisionamiento`);
        location.hash = `#/tenants/${r.tenant.id}/op/${r.operacion.id}`;
      } catch (e) {
        document.getElementById('e-crear').textContent = e.message;
        boton.disabled = false; boton.textContent = 'Crear tenant';
      }
    };

    pintar();
  },

  // ---------------------------------------------------------------- Detalle del tenant
  async detalle(id, opId) {
    const t = await api(`/tenants/${encodeURIComponent(id)}`);
    const p = t.plan_detalle;
    const ultima = t.operaciones[0];
    const opSel = opId || ultima?.id;
    const ocupado = t.operaciones.some((o) => [...ACTIVAS, 'esperando_confirmacion'].includes(o.estado));

    const botones = [];
    if (!ocupado && t.estado === 'activo') botones.push('<button class="boton" data-accion="suspender">Suspender</button>');
    if (!ocupado && t.estado === 'suspendido') botones.push('<button class="boton primario" data-accion="reanudar">Reanudar</button>');
    if (!ocupado && t.estado === 'fallido' && ultima?.estado === 'fallida') botones.push(`<button class="boton primario" data-reintentar="${ultima.id}">Reintentar ${esc(TEXTO_TIPO[ultima.tipo].toLowerCase())}</button>`);
    if (!ocupado && ['activo', 'suspendido', 'fallido'].includes(t.estado)) botones.push('<button class="boton peligro" data-accion="eliminar">Eliminar…</button>');

    V().innerHTML = `
      <div class="cabecera">
        <div><h1>${esc(t.nombre)} ${badge(t.estado)}</h1>
          <p class="muted"><span class="mono">${esc(t.id)}</span> · ${esc(t.contacto_email)}
          ${t.url ? ` · <a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.url)}</a>` : ''}</p></div>
        <div class="acciones">${botones.join('')}</div>
      </div>
      <div class="tarjeta datos-clave">
        <div><span>Plan</span><strong>${esc(p?.nombre || t.plan)}</strong> <small class="muted">${esc(p?.infra.instance_type || '')}</small></div>
        <div><span>Entorno</span>${esc(ENTORNOS[t.entorno] || t.entorno)}</div>
        <div><span>Motor</span>${esc(MOTORES[t.motor]?.nombre || t.motor)}</div>
        <div><span>Instancia</span><span class="mono">${esc(t.instance_id || '—')}</span></div>
        <div><span>Versión de la app</span>${esc(t.app_version || '—')}</div>
        <div><span>Datos</span>${p ? `${p.infra.data_volume_gb} GB · retención ${p.operacion.retencion_suspendido_dias} días` : '—'}</div>
        <div><span>Creado</span>${fecha(t.creado_en)} <small class="muted">por ${esc(t.creado_por)}</small></div>
        <div><span>Actualizado</span>${fecha(t.actualizado_en)}</div>
      </div>
      <div class="grid" style="grid-template-columns:minmax(0,5fr) minmax(0,7fr);margin-top:16px;align-items:start">
        <div class="tarjeta"><h2>Historial de operaciones</h2>${tablaOperaciones(t.operaciones, { seleccion: opSel, tenantId: t.id })}</div>
        <div class="tarjeta" id="panel-op">${opSel ? '<p class="muted">Cargando operación…</p>' : '<div class="vacio">Sin operaciones</div>'}</div>
      </div>`;

    document.querySelectorAll('[data-accion]').forEach((b) => b.addEventListener('click', async () => {
      const accion = b.dataset.accion;
      if (accion === 'suspender' && !confirm(`¿Suspender ${t.id}? La instancia se detendrá; los datos se conservan.`)) return;
      b.disabled = true;
      try {
        const r = await api(`/tenants/${t.id}/${accion}`, { metodo: 'POST' });
        location.hash = `#/tenants/${t.id}/op/${r.operacion.id}`;
      } catch (e) { avisar(e.message, 'mal'); b.disabled = false; }
    }));
    document.querySelectorAll('[data-reintentar]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await api(`/operaciones/${b.dataset.reintentar}/reintentar`, { metodo: 'POST' });
        location.hash = `#/tenants/${t.id}/op/${r.operacion.id}`;
      } catch (e) { avisar(e.message, 'mal'); b.disabled = false; }
    }));

    if (!opSel) return null;
    return panelOperacion(opSel, t);
  },

  // ---------------------------------------------------------------- Planes
  async planes() {
    const c = await api('/planes');
    const filas = [
      ['Cómputo', (p) => `${esc(p.infra.instance_type)} · ${p.infra.vcpu} vCPU · ${p.infra.memoria_gib} GiB`],
      ['Volumen de datos', (p) => `${p.infra.data_volume_gb} GB ${esc(p.infra.volume_type)} cifrado`],
      ['Disco del sistema', (p) => `${p.infra.root_volume_gb} GB`],
      ['Estudiantes', (p) => `hasta ${num(p.limites.estudiantes)}`],
      ['Docentes', (p) => `hasta ${num(p.limites.docentes)}`],
      ['Cursos', (p) => `hasta ${num(p.limites.cursos)}`],
      ['Importación Excel', (p) => `hasta ${p.limites.tamano_importacion_mb} MB`],
      ['Retención si se suspende', (p) => `${p.operacion.retencion_suspendido_dias} días`],
      ['Respaldo', (p) => `${esc(p.operacion.respaldo)}, ${p.operacion.retencion_respaldos_dias} días <span class="badge">fase final</span>`],
      ['Intervalo de métricas', (p) => `${p.monitoreo.intervalo_metricas_s} s`],
      ['Costo activo', (p) => usd(p.costo_estimado.activo_mes)],
      ['Costo suspendido', (p) => usd(p.costo_estimado.suspendido_mes)],
    ];
    V().innerHTML = `
      <div class="cabecera"><div><h1>Planes</h1><p class="muted">Catálogo de planes y límites (versión ${esc(c.version)}, región ${esc(c.region)}). Fuente: <code>catalogo/planes.json</code>.</p></div></div>
      <div class="tarjeta"><table>
        <thead><tr><th></th>${c.planes.map((p) => `<th><strong style="color:var(--texto);font-size:14px">${esc(p.nombre)}</strong><br>${esc(p.descripcion)}</th>`).join('')}</tr></thead>
        <tbody>${filas.map(([n, f]) => `<tr><td class="muted">${n}</td>${c.planes.map((p) => `<td>${f(p)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <div class="tarjeta"><h2>Incluido en todos los planes</h2>
        <ul class="lista-puntos">${c.comunes.incluye.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
        <h3 style="margin-top:12px">Umbrales de alerta</h3>
        <p class="muted">Servicio caído ${c.comunes.alertas.servicio_caido_min} min · ${c.comunes.alertas.errores_5xx_por_min} errores 5xx/min · CPU ${c.comunes.alertas.cpu_porcentaje}% ·
          memoria ${c.comunes.alertas.memoria_porcentaje}% · disco de datos ${c.comunes.alertas.disco_datos_porcentaje}% · estudiantes ${c.comunes.alertas.estudiantes_porcentaje_limite}% del límite</p>
      </div>`;
  },

  // ---------------------------------------------------------------- Monitoreo
  async monitoreo() {
    V().innerHTML = `
      <div class="cabecera"><div><h1>Monitoreo</h1><p class="muted">Salud, métricas y alertas por tenant y entorno.</p></div></div>
      <div class="tarjeta"><div class="vacio">
        <h2>Grafana se integra en la siguiente etapa</h2>
        <p>Aquí se mostrarán el panel de Grafana por tenant y las alertas recientes (RF-25 a RF-29).</p>
      </div></div>`;
  },

  // ---------------------------------------------------------------- Auditoría
  async auditoria() {
    V().innerHTML = `
      <div class="cabecera"><div><h1>Auditoría</h1><p class="muted">Historial de todas las operaciones: quién, cuándo y con qué resultado.</p></div>
        <select id="f-estado" style="width:220px"><option value="">Todos los resultados</option>
          ${['exitosa', 'fallida', 'en_curso', 'pendiente', 'esperando_confirmacion', 'cancelada'].map((e) => `<option value="${e}">${esc(TEXTO_ESTADO[e] || e)}</option>`).join('')}</select></div>
      <div class="tarjeta" id="lista"></div>`;
    const cargar = async () => {
      const e = document.getElementById('f-estado').value;
      const ops = await api(`/operaciones?limite=200${e ? `&estado=${e}` : ''}`);
      document.getElementById('lista').innerHTML = tablaOperaciones(ops, { conTenant: true, completa: true });
    };
    document.getElementById('f-estado').addEventListener('change', cargar);
    await cargar();
  },

  // ---------------------------------------------------------------- Configuración
  async configuracion() {
    V().innerHTML = `
      <div class="cabecera"><div><h1>Configuración</h1><p class="muted">Credenciales de esta sesión del navegador (se guardan solo en esta pestaña).</p></div></div>
      <div class="tarjeta" style="max-width:520px">
        <div class="campo"><label>Usuario</label><input id="c-usuario" value="${esc(Sesion.get('usuario') || 'admin')}">
          <div class="ayuda">Queda registrado como quien inició cada operación.</div></div>
        <div class="campo"><label>Clave de administrador</label><input id="c-clave" type="password" value="${esc(Sesion.get('adminKey'))}">
          <div class="ayuda">Valor de <code>PLATAFORMA_ADMIN_KEY</code> en el servidor. Vacía si la API corre sin autenticación.</div></div>
        <button class="boton primario" id="b-guardar">Guardar</button>
      </div>`;
    document.getElementById('b-guardar').addEventListener('click', () => {
      Sesion.set('usuario', document.getElementById('c-usuario').value.trim() || 'admin');
      Sesion.set('adminKey', document.getElementById('c-clave').value);
      pintarUsuario();
      avisar('Configuración guardada');
    });
  },
};

// ---------------------------------------------------------------- Componentes
function tablaOperaciones(ops, { conTenant = false, completa = false, seleccion = null, tenantId = null } = {}) {
  if (!ops.length) return '<div class="vacio">Sin operaciones</div>';
  return `<table><thead><tr><th>#</th>${conTenant ? '<th>Tenant</th>' : ''}<th>Operación</th><th>Estado</th>
    ${completa ? '<th>Iniciada por</th><th>Duración</th><th>Error</th>' : ''}<th>Fecha</th></tr></thead>
    <tbody>${ops.map((o) => `
      <tr class="clic ${o.id === seleccion ? 'sel' : ''}" onclick="location.hash='#/tenants/${esc(tenantId || o.tenant_id)}/op/${o.id}'">
        <td class="mono">${o.id}</td>${conTenant ? `<td class="mono">${esc(o.tenant_id)}</td>` : ''}
        <td>${esc(TEXTO_TIPO[o.tipo] || o.tipo)}${o.reintento_de ? ` <small class="muted">(reintento de #${o.reintento_de})</small>` : ''}</td>
        <td>${badge(o.estado)}</td>
        ${completa ? `<td>${esc(o.solicitado_por)}</td><td>${duracion(o.iniciada_en, o.terminada_en)}</td><td><small>${esc(o.error || '')}</small></td>` : ''}
        <td><small>${fecha(o.creada_en)}</small></td>
      </tr>`).join('')}</tbody></table>`;
}

function pintarLog(texto) {
  return esc(texto).split('\n').map((l) => (l.startsWith('==&gt;') ? `<span class="paso-log">${l}</span>`
    : l.startsWith('ERROR') ? `<span class="err-log">${l}</span>` : l)).join('\n');
}

// Panel de una operación con sondeo del progreso y del log (RF-11)
function panelOperacion(opId, tenant) {
  let largo = 0; let timer = null; let vivo = true; let estadoPrevio = null;
  const panel = () => document.getElementById('panel-op');

  const pintarCabecera = (o) => {
    const activa = ACTIVAS.includes(o.estado);
    const v = o.versiones || {};
    const pl = v.plantillas || {};
    let extra = '';
    if (o.error) extra += `<div class="nota mal" style="margin-bottom:12px"><strong>Error:</strong> ${esc(o.error)}</div>`;
    if (o.tipo === 'plan_eliminar' && o.estado === 'esperando_confirmacion') {
      const r = o.resultado || {};
      extra += `<div class="nota mal" style="margin-bottom:12px">
        <strong>Se eliminarán ${r.recursos.length} recursos.</strong> ${esc(r.aviso || '')}
        <ul style="margin:8px 0">${r.recursos.map((x) => `<li><code>${esc(x.tipo)}</code> ${esc(x.nombre || '')}
          ${r.datos.some((dd) => dd.direccion === x.direccion) ? ' <strong>(datos)</strong>' : ''}</li>`).join('')}</ul>
        <label style="margin-top:8px">Para confirmar escribe <code>${esc(tenant.id)}</code></label>
        <input id="c-confirmar" class="mono" autocomplete="off" style="margin-bottom:8px">
        <div class="acciones"><button class="boton peligro lleno" id="b-confirmar" disabled>Eliminar definitivamente</button>
          <button class="boton" id="b-cancelar">Cancelar</button></div>
      </div>`;
    }
    if (o.resultado?.outputs) {
      const out = o.resultado.outputs;
      extra += `<table style="margin-bottom:12px"><tbody>${Object.entries(out).filter(([, val]) => val !== null)
        .map(([k, val]) => `<tr><td class="muted mono">${esc(k)}</td><td class="mono">${esc(typeof val === 'object' ? JSON.stringify(val) : val)}</td></tr>`).join('')}</tbody></table>`;
    }
    if (v.motor || pl.commit) {
      extra += `<p class="muted"><small>Versiones (RF-13): app <strong>${esc(v.app || '—')}</strong> ·
        plantillas <span class="mono">${esc((pl.commit || '').slice(0, 8))}</span>${pl.cambios_sin_commit ? ' (+cambios locales)' : ''} ${pl.ref ? `@${esc(pl.ref)}` : `(${esc(pl.origen || '')})`} ·
        ${esc(v.motor?.nombre || '')} ${esc(v.motor?.version || '')}${v.ami ? ` · AMI <span class="mono">${esc(v.ami)}</span>` : ''}
        ${Object.entries(v.motor?.providers || {}).map(([k, ver]) => `· ${esc(k.split('/').pop())} ${esc(ver)}`).join(' ')}</small></p>`;
    }
    return `
      <div class="cabecera" style="margin-bottom:8px"><div>
        <h2>#${o.id} ${esc(TEXTO_TIPO[o.tipo] || o.tipo)} ${badge(o.estado)}</h2>
        <small class="muted">${esc(o.paso || '')} · por ${esc(o.solicitado_por)} · ${fecha(o.creada_en)} · ${duracion(o.iniciada_en, o.terminada_en)}</small>
      </div></div>
      ${activa ? '<div class="progreso"><div></div></div>' : ''}
      ${extra}
      <h3>Log</h3>`;
  };

  const enlazarConfirmacion = () => {
    const input = document.getElementById('c-confirmar');
    if (!input) return;
    const boton = document.getElementById('b-confirmar');
    input.addEventListener('input', () => { boton.disabled = input.value !== tenant.id; });
    boton.addEventListener('click', async () => {
      boton.disabled = true;
      try {
        const r = await api(`/operaciones/${opId}/confirmar`, { metodo: 'POST', cuerpo: { confirmacion: input.value } });
        location.hash = `#/tenants/${tenant.id}/op/${r.operacion.id}`;
      } catch (e) { avisar(e.message, 'mal'); boton.disabled = false; }
    });
    document.getElementById('b-cancelar').addEventListener('click', async () => {
      try { await api(`/operaciones/${opId}/cancelar`, { metodo: 'POST' }); navegar(); } catch (e) { avisar(e.message, 'mal'); }
    });
  };

  const sondear = async () => {
    if (!vivo) return;
    try {
      const o = await api(`/operaciones/${opId}?desde=${largo}`);
      if (!vivo || !panel()) return;
      if (estadoPrevio && estadoPrevio !== o.estado && !ACTIVAS.includes(o.estado)) { navegar(); return; } // terminó: recargar todo
      if (estadoPrevio !== o.estado || !document.getElementById('log-op')) {
        panel().innerHTML = `${pintarCabecera(o)}<pre class="log" id="log-op"></pre>`;
        largo = 0;
        enlazarConfirmacion();
        if (o.log_total && o.log.length !== o.log_total) { estadoPrevio = o.estado; return sondear(); } // traer el log completo
      }
      estadoPrevio = o.estado;
      if (o.log) {
        const pre = document.getElementById('log-op');
        const alFinal = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
        pre.insertAdjacentHTML('beforeend', pintarLog(o.log));
        if (alFinal) pre.scrollTop = pre.scrollHeight;
      }
      largo = o.log_total;
      if (ACTIVAS.includes(o.estado)) timer = setTimeout(sondear, 2000);
    } catch (e) {
      if (panel()) panel().insertAdjacentHTML('afterbegin', `<div class="nota mal">${esc(e.message)}</div>`);
    }
  };
  sondear();
  return () => { vivo = false; clearTimeout(timer); };
}
