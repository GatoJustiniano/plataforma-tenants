// Router por hash: #/inicio, #/tenants, #/tenants/nuevo, #/tenants/:id[/op/:opId], #/planes, ...
const vistaEl = document.getElementById('vista');
const migasEl = document.getElementById('migas');

const RUTAS = [
  [/^\/inicio$/, () => Vistas.inicio(), ['Inicio'], 'inicio'],
  [/^\/tenants$/, () => Vistas.tenants(), ['Tenants'], 'tenants'],
  [/^\/tenants\/nuevo$/, () => Vistas.crear(), ['Tenants', 'Crear tenant'], 'tenants'],
  [/^\/tenants\/([a-z0-9-]+)(?:\/op\/(\d+))?$/, (m) => Vistas.detalle(m[1], m[2] && Number(m[2])), (m) => ['Tenants', m[1]], 'tenants'],
  [/^\/planes$/, () => Vistas.planes(), ['Planes'], 'planes'],
  [/^\/monitoreo$/, () => Vistas.monitoreo(), ['Monitoreo'], 'monitoreo'],
  [/^\/auditoria$/, () => Vistas.auditoria(), ['Auditoría'], 'auditoria'],
  [/^\/configuracion$/, () => Vistas.configuracion(), ['Configuración'], 'configuracion'],
];

let limpiarVista = null; // cada vista puede devolver una función para cancelar su sondeo

async function navegar() {
  if (limpiarVista) { limpiarVista(); limpiarVista = null; }
  const ruta = location.hash.replace(/^#/, '') || '/inicio';
  const entrada = RUTAS.find(([re]) => re.test(ruta));
  if (!entrada) { location.hash = '#/inicio'; return; }
  const [re, render, migas, menu] = entrada;
  const m = ruta.match(re);
  const partes = typeof migas === 'function' ? migas(m) : migas;
  migasEl.innerHTML = partes.map((p, i) => (i === partes.length - 1 ? `<strong>${esc(p)}</strong>`
    : `<a href="#/${p === 'Tenants' ? 'tenants' : 'inicio'}">${esc(p)}</a>`)).join(' / ');
  document.querySelectorAll('.sidebar nav a').forEach((a) => a.classList.toggle('activo', a.dataset.ruta === menu));
  vistaEl.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    limpiarVista = (await render(m)) || null;
  } catch (e) {
    vistaEl.innerHTML = `<div class="nota mal">${esc(e.message)}${e.status === 401
      ? ' — configura la clave de administrador en <a href="#/configuracion">Configuración</a>.' : ''}</div>`;
  }
  window.scrollTo(0, 0);
}

function pintarUsuario() {
  const u = Sesion.get('usuario') || 'admin';
  document.getElementById('nombre-usuario').textContent = u;
  document.getElementById('avatar').textContent = u.slice(0, 2).toUpperCase();
}

window.addEventListener('hashchange', navegar);
pintarUsuario();
navegar();
