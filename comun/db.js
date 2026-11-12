// Base de datos de la plataforma (SQLite integrado en Node 22).
// La comparten la API (escribe solicitudes) y el worker (las ejecuta).
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.resolve(__dirname, '..', process.env.DB_PATH || './plataforma.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;      -- API y worker leen/escriben a la vez
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS tenants (
    id              TEXT PRIMARY KEY,            -- identificador único (subdominio)
    nombre          TEXT NOT NULL,
    contacto_email  TEXT NOT NULL,
    entorno         TEXT NOT NULL,               -- dev | qa | prod
    plan            TEXT NOT NULL,               -- basico | estandar | avanzado
    motor           TEXT NOT NULL,               -- terraform | opentofu | pulumi | cloudformation
    estado          TEXT NOT NULL,               -- ver ESTADOS_TENANT
    url             TEXT,
    instance_id     TEXT,
    app_version     TEXT,
    creado_por      TEXT NOT NULL,
    creado_en       TEXT NOT NULL,
    actualizado_en  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS operaciones (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    tipo            TEXT NOT NULL,               -- ver TIPOS_OPERACION
    estado          TEXT NOT NULL,               -- pendiente | en_curso | exitosa | fallida | esperando_confirmacion | cancelada
    solicitado_por  TEXT NOT NULL,
    reintento_de    INTEGER REFERENCES operaciones(id),
    paso            TEXT,                        -- paso actual, para mostrar progreso
    error           TEXT,                        -- mensaje comprensible (sin secretos)
    log             TEXT NOT NULL DEFAULT '',    -- salida del motor ya saneada
    resultado       TEXT,                        -- JSON: outputs, recursos a eliminar, etc.
    versiones       TEXT,                        -- JSON: app, plantillas, motor (RF-13)
    creada_en       TEXT NOT NULL,
    iniciada_en     TEXT,
    terminada_en    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ops_tenant ON operaciones(tenant_id, id);
  CREATE INDEX IF NOT EXISTS idx_ops_estado ON operaciones(estado, id);
`);

const ESTADOS_TENANT = [
  'aprovisionando', 'activo', 'fallido',
  'suspendiendo', 'suspendido', 'reanudando',
  'eliminando', 'eliminado',
];

// Qué estado toma el tenant mientras corre cada operación y al terminar bien
const TIPOS_OPERACION = {
  crear:          { durante: 'aprovisionando', exito: 'activo' },
  suspender:      { durante: 'suspendiendo',   exito: 'suspendido' },
  reanudar:       { durante: 'reanudando',     exito: 'activo' },
  plan_eliminar:  { durante: null,             exito: null },        // solo calcula qué se borrará
  eliminar:       { durante: 'eliminando',     exito: 'eliminado' },
};

const ahora = () => new Date().toISOString();

module.exports = { db, DB_PATH, ESTADOS_TENANT, TIPOS_OPERACION, ahora };
