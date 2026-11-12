// API de la plataforma. No ejecuta infraestructura: valida, registra la operación
// y responde 202. El worker la toma y la ejecuta en segundo plano.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, TIPOS_OPERACION, ahora } = require('../comun/db');
const { leerCatalogo, obtenerPlan } = require('../comun/catalogo');
const { monitoreo } = require('./grafana');

const PORT = Number(process.env.PORT) || 4000;
const ADMIN_KEY = process.env.PLATAFORMA_ADMIN_KEY || '';
const MOTORES = ['terraform', 'opentofu', 'pulumi', 'cloudformation'];
const ENTORNOS = ['dev', 'qa', 'prod'];
const RE_ID = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = express();
app.use(express.json({ limit: '100kb' }));

// ---------- Autenticación del administrador de la plataforma ----------
function iguales(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

app.use('/api', (req, res, next) => {
  if (req.path === '/salud') return next();
  if (ADMIN_KEY && !iguales(req.get('X-Admin-Key') || '', ADMIN_KEY)) {
    return res.status(401).json({ error: 'Clave de administrador inválida o ausente' });
  }
  req.usuario = (req.get('X-Usuario') || 'admin').slice(0, 60);
  next();
});

// ---------- Utilidades ----------
const err = (res, code, msg) => res.status(code).json({ error: msg });

function getTenant(id) {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
}

function operacionActiva(tenantId) {
  return db.prepare(`SELECT * FROM operaciones WHERE tenant_id = ?
    AND estado IN ('pendiente','en_curso','esperando_confirmacion') ORDER BY id DESC LIMIT 1`).get(tenantId);
}

function formatoOperacion(op, { conLog = false } = {}) {
  if (!op) return null;
  const o = { ...op, resultado: op.resultado ? JSON.parse(op.resultado) : null,
    versiones: op.versiones ? JSON.parse(op.versiones) : null };
  if (!conLog) delete o.log;
  return o;
}

function encolar(tenantId, tipo, usuario, reintentoDe = null) {
  const r = db.prepare(`INSERT INTO operaciones (tenant_id, tipo, estado, solicitado_por, reintento_de, paso, creada_en)
    VALUES (?, ?, 'pendiente', ?, ?, 'En cola', ?)`).run(tenantId, tipo, usuario, reintentoDe, ahora());
  const durante = TIPOS_OPERACION[tipo].durante;
  if (durante) db.prepare('UPDATE tenants SET estado = ?, actualizado_en = ? WHERE id = ?').run(durante, ahora(), tenantId);
  return db.prepare('SELECT * FROM operaciones WHERE id = ?').get(r.lastInsertRowid);
}

// ---------- Rutas ----------
app.get('/api/salud', (req, res) => res.json({ ok: true, hora: ahora() }));

// Catálogo de planes (RF-01, RF-03)
app.get('/api/planes', (req, res) => res.json(leerCatalogo()));

// Consultar tenants por nombre, estado, plan y entorno (RF-14)
app.get('/api/tenants', (req, res) => {
  const filtros = []; const args = [];
  if (req.query.nombre) { filtros.push('(nombre LIKE ? OR id LIKE ?)'); args.push(`%${req.query.nombre}%`, `%${req.query.nombre}%`); }
  for (const campo of ['estado', 'plan', 'entorno', 'motor']) {
    if (req.query[campo]) { filtros.push(`${campo} = ?`); args.push(String(req.query[campo])); }
  }
  if (!req.query.estado && req.query.incluir_eliminados !== 'true') filtros.push("estado != 'eliminado'");
  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
  res.json(db.prepare(`SELECT * FROM tenants ${where} ORDER BY creado_en DESC`).all(...args));
});

app.get('/api/tenants/:id', (req, res) => {
  const t = getTenant(req.params.id);
  if (!t) return err(res, 404, 'Tenant no encontrado');
  const ops = db.prepare('SELECT * FROM operaciones WHERE tenant_id = ? ORDER BY id DESC LIMIT 50').all(t.id);
  res.json({ ...t, plan_detalle: obtenerPlan(t.plan), operaciones: ops.map((o) => formatoOperacion(o)) });
});

// Crear tenant (RF-07, RF-08)
app.post('/api/tenants', (req, res) => {
  const { id, nombre, contacto_email, entorno = 'dev', plan, motor = 'terraform' } = req.body || {};
  if (!RE_ID.test(id || '')) return err(res, 400, 'Identificador inválido: 3-30 caracteres, minúsculas, números y guiones');
  if (!nombre || String(nombre).trim().length < 3) return err(res, 400, 'El nombre de la institución es obligatorio');
  if (!RE_EMAIL.test(contacto_email || '')) return err(res, 400, 'Correo de contacto inválido');
  if (!ENTORNOS.includes(entorno)) return err(res, 400, `Entorno inválido (${ENTORNOS.join(', ')})`);
  if (!obtenerPlan(plan)) return err(res, 400, 'Plan inexistente');
  if (!MOTORES.includes(motor)) return err(res, 400, `Motor inválido (${MOTORES.join(', ')})`);

  const existente = getTenant(id);
  if (existente && existente.estado !== 'eliminado') return err(res, 409, `Ya existe un tenant con el identificador "${id}"`);

  const t = ahora();
  const appVersion = process.env.APP_VERSION || 'main';
  if (existente) {
    db.prepare(`UPDATE tenants SET nombre=?, contacto_email=?, entorno=?, plan=?, motor=?, estado='aprovisionando',
      url=NULL, instance_id=NULL, app_version=?, creado_por=?, creado_en=?, actualizado_en=? WHERE id=?`)
      .run(String(nombre).trim(), contacto_email, entorno, plan, motor, appVersion, req.usuario, t, t, id);
  } else {
    db.prepare(`INSERT INTO tenants (id, nombre, contacto_email, entorno, plan, motor, estado, app_version, creado_por, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, 'aprovisionando', ?, ?, ?, ?)`)
      .run(id, String(nombre).trim(), contacto_email, entorno, plan, motor, appVersion, req.usuario, t, t);
  }
  const op = encolar(id, 'crear', req.usuario);
  res.status(202).json({ tenant: getTenant(id), operacion: formatoOperacion(op) });
});

// Acciones del ciclo de vida: estados desde los que se permite cada una
const ACCIONES = {
  suspender:     { tipo: 'suspender',     desde: ['activo'] },
  reanudar:      { tipo: 'reanudar',      desde: ['suspendido'] },
  eliminar:      { tipo: 'plan_eliminar', desde: ['activo', 'suspendido', 'fallido'] }, // RF-18: primero se previsualiza
};

app.post('/api/tenants/:id/:accion(suspender|reanudar|eliminar)', (req, res) => {
  const t = getTenant(req.params.id);
  if (!t) return err(res, 404, 'Tenant no encontrado');
  const accion = ACCIONES[req.params.accion];
  if (!accion.desde.includes(t.estado)) return err(res, 409, `No se puede ${req.params.accion} un tenant en estado "${t.estado}"`);
  const activa = operacionActiva(t.id);
  if (activa) return err(res, 409, `El tenant ya tiene una operación en curso (#${activa.id} ${activa.tipo}: ${activa.estado})`);
  res.status(202).json({ operacion: formatoOperacion(encolar(t.id, accion.tipo, req.usuario)) });
});

// Operaciones
app.get('/api/operaciones', (req, res) => {
  const args = []; let where = '';
  if (req.query.tenant) { where = 'WHERE tenant_id = ?'; args.push(String(req.query.tenant)); }
  if (req.query.estado) { where += (where ? ' AND' : 'WHERE') + ' estado = ?'; args.push(String(req.query.estado)); }
  const limite = Math.min(Number(req.query.limite) || 50, 200);
  res.json(db.prepare(`SELECT * FROM operaciones ${where} ORDER BY id DESC LIMIT ${limite}`).all(...args)
    .map((o) => formatoOperacion(o)));
});

// Progreso y log de una operación (RF-11). ?desde=N devuelve solo el log nuevo.
app.get('/api/operaciones/:id', (req, res) => {
  const op = db.prepare('SELECT * FROM operaciones WHERE id = ?').get(Number(req.params.id));
  if (!op) return err(res, 404, 'Operación no encontrada');
  const o = formatoOperacion(op, { conLog: true });
  const desde = Number(req.query.desde) || 0;
  o.log_total = o.log.length;
  o.log = o.log.slice(desde);
  res.json(o);
});

// Confirmar o cancelar una eliminación ya previsualizada (RF-18)
app.post('/api/operaciones/:id/:accion(confirmar|cancelar)', (req, res) => {
  const op = db.prepare('SELECT * FROM operaciones WHERE id = ?').get(Number(req.params.id));
  if (!op) return err(res, 404, 'Operación no encontrada');
  if (op.tipo !== 'plan_eliminar' || op.estado !== 'esperando_confirmacion') {
    return err(res, 409, 'Solo se puede confirmar o cancelar una eliminación que espera confirmación');
  }
  const t = getTenant(op.tenant_id);
  if (req.params.accion === 'cancelar') {
    db.prepare("UPDATE operaciones SET estado='cancelada', paso='Cancelada por el usuario', terminada_en=? WHERE id=?").run(ahora(), op.id);
    return res.json({ operacion: formatoOperacion(db.prepare('SELECT * FROM operaciones WHERE id = ?').get(op.id)) });
  }
  // El usuario debe escribir el identificador del tenant para confirmar
  if ((req.body || {}).confirmacion !== t.id) return err(res, 400, `Para confirmar escribe el identificador del tenant: "${t.id}"`);
  db.prepare("UPDATE operaciones SET estado='exitosa', paso='Eliminación confirmada', terminada_en=? WHERE id=?").run(ahora(), op.id);
  res.status(202).json({ operacion: formatoOperacion(encolar(t.id, 'eliminar', req.usuario, null)) });
});

// Reintentar una operación fallida sin duplicar recursos (RF-12):
// el motor reaplica sobre el mismo estado y solo crea lo que falta.
app.post('/api/operaciones/:id/reintentar', (req, res) => {
  const op = db.prepare('SELECT * FROM operaciones WHERE id = ?').get(Number(req.params.id));
  if (!op) return err(res, 404, 'Operación no encontrada');
  if (op.estado !== 'fallida') return err(res, 409, 'Solo se pueden reintentar operaciones fallidas');
  const activa = operacionActiva(op.tenant_id);
  if (activa) return err(res, 409, `El tenant ya tiene una operación en curso (#${activa.id})`);
  const ultima = db.prepare('SELECT id FROM operaciones WHERE tenant_id = ? ORDER BY id DESC LIMIT 1').get(op.tenant_id);
  if (ultima.id !== op.id) return err(res, 409, 'Solo se puede reintentar la última operación del tenant');
  res.status(202).json({ operacion: formatoOperacion(encolar(op.tenant_id, op.tipo, req.usuario, op.id)) });
});

// ---------- Frontend ----------
// ---------- Monitoreo: reglas y alertas de Grafana (RF-29) ----------
app.get('/api/monitoreo', async (req, res) => {
  const datos = await monitoreo();
  const tenant = String(req.query.tenant || '');
  if (!tenant || !datos.reglas) return res.json(datos);
  // Solo las alertas de un tenant (vista de detalle)
  res.json({ ...datos, reglas: datos.reglas.map((r) => ({ ...r, alertas: r.alertas.filter((a) => a.tenant === tenant) })) });
});

app.use(express.static(path.resolve(__dirname, '..', 'frontend')));

app.use((e, req, res, next) => {
  console.error(e);
  err(res, e.status || 500, e.type === 'entity.parse.failed' ? 'JSON inválido' : 'Error interno');
});

app.listen(PORT, () => {
  console.log(`API de la plataforma en http://localhost:${PORT}`);
  if (!ADMIN_KEY) console.warn('AVISO: PLATAFORMA_ADMIN_KEY vacía, la API no pide autenticación');
});
