// Cliente de la API y utilidades compartidas por las vistas.
const Sesion = {
  get(k) { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

class ErrorApi extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function api(ruta, { metodo = 'GET', cuerpo } = {}) {
  const headers = { 'X-Usuario': Sesion.get('usuario') || 'admin' };
  const clave = Sesion.get('adminKey');
  if (clave) headers['X-Admin-Key'] = clave;
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(`/api${ruta}`, { method: metodo, headers, body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined });
  } catch {
    throw new ErrorApi('No se pudo contactar con la API de la plataforma', 0);
  }
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErrorApi(datos.error || `Error ${r.status}`, r.status);
  return datos;
}

// ---------- Utilidades de presentación ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fecha(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function duracion(desde, hasta) {
  if (!desde) return '—';
  const s = Math.round(((hasta ? new Date(hasta) : new Date()) - new Date(desde)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const CLASE_ESTADO = {
  activo: 'ok', exitosa: 'ok',
  aprovisionando: 'curso', reanudando: 'curso', suspendiendo: 'curso', eliminando: 'curso', en_curso: 'curso', pendiente: 'curso',
  suspendido: 'alerta', esperando_confirmacion: 'alerta',
  fallido: 'mal', fallida: 'mal',
  eliminado: '', cancelada: '',
};
const TEXTO_ESTADO = {
  esperando_confirmacion: 'esperando confirmación', en_curso: 'en curso',
};
const badge = (estado) => `<span class="badge ${CLASE_ESTADO[estado] ?? ''}">${esc(TEXTO_ESTADO[estado] || estado)}</span>`;

const TEXTO_TIPO = {
  crear: 'Crear', suspender: 'Suspender', reanudar: 'Reanudar',
  plan_eliminar: 'Previsualizar eliminación', eliminar: 'Eliminar',
};
const ENTORNOS = { dev: 'Desarrollo', qa: 'Pruebas', prod: 'Producción' };
const MOTORES = {
  terraform: { nombre: 'Terraform', listo: true },
  opentofu: { nombre: 'OpenTofu', listo: true },
  pulumi: { nombre: 'Pulumi', listo: false },
  cloudformation: { nombre: 'CloudFormation', listo: false },
};

const usd = (n) => `~${Number(n).toFixed(1)} USD/mes`;
const num = (n) => Number(n).toLocaleString('es');

function avisar(msg, tipo = '') {
  const el = document.getElementById('aviso');
  el.textContent = msg;
  el.className = `aviso ${tipo}`;
  el.hidden = false;
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => { el.hidden = true; }, 4500);
}
