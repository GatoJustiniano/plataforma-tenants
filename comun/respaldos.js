// Respaldos de los tenants (RF-19): snapshots del volumen de datos (SQLite).
// - Programados: los crea AWS Data Lifecycle Manager, una política por plan (infra/plataforma).
// - A pedido y antes de restaurar: los crea el worker con este módulo.
// Usa el AWS CLI con las credenciales de la plataforma (perfil en local, rol IAM en la EC2).
const { execFile } = require('child_process');

const REGION = process.env.AWS_REGION || 'us-east-1';
const ORIGENES_PROPIOS = ['manual', 'pre-restauracion']; // los que expira la plataforma (DLM expira los suyos)

function aws(args, { timeout = 60000 } = {}) {
  return new Promise((ok, ko) => {
    execFile('aws', [...args, '--region', REGION, '--output', 'json'], { timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (e, stdout, stderr) => {
        if (e) return ko(Object.assign(new Error(`AWS CLI: ${String(stderr || e.message).trim().split('\n').pop()}`), { salida: String(stderr || '') }));
        try { ok(stdout.trim() ? JSON.parse(stdout) : {}); } catch { ok({}); }
      });
  });
}

const tag = (recurso, clave) => (recurso.Tags || []).find((t) => t.Key === clave)?.Value;

// Volumen de datos de un tenant (tag Name=asistencia-<id>-datos que pone el módulo)
async function volumenDatos(tenantId) {
  const r = await aws(['ec2', 'describe-volumes', '--filters',
    `Name=tag:Tenant,Values=${tenantId}`, 'Name=tag:Componente,Values=tenant', `Name=tag:Name,Values=asistencia-${tenantId}-datos`]);
  const vols = (r.Volumes || []).filter((v) => v.State !== 'deleting' && v.State !== 'deleted');
  if (!vols.length) throw new Error(`No se encontró el volumen de datos del tenant ${tenantId}`);
  return vols[0];
}

// Lista los snapshots del tenant, del más nuevo al más antiguo
async function listar(tenantId, plan) {
  const r = await aws(['ec2', 'describe-snapshots', '--owner-ids', 'self', '--filters',
    `Name=tag:Tenant,Values=${tenantId}`, 'Name=tag:Componente,Values=tenant']);
  const dias = plan?.operacion?.retencion_respaldos_dias || 0;
  return (r.Snapshots || []).map((s) => {
    const origen = tag(s, 'Origen') || (tag(s, 'aws:dlm:lifecycle-policy-id') ? 'programado' : 'manual');
    // Los de DLM no llevan ExpiraEn: vencen a los N días del plan desde su creación
    const expira = tag(s, 'ExpiraEn') || (dias ? new Date(new Date(s.StartTime).getTime() + dias * 864e5).toISOString() : null);
    return {
      id: s.SnapshotId, fecha: s.StartTime, estado: s.State, progreso: s.Progress,
      tamano_gb: s.VolumeSize, volumen: s.VolumeId, origen, expira, descripcion: s.Description || '',
      solicitado_por: tag(s, 'SolicitadoPor') || null,
    };
  }).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
}

// Crea un snapshot del volumen de datos y espera a que termine. Devuelve su id.
async function crear(tenant, plan, { origen, usuario, registro }) {
  const vol = await volumenDatos(tenant.id);
  const dias = plan?.operacion?.retencion_respaldos_dias || 7;
  const expira = new Date(Date.now() + dias * 864e5).toISOString();
  const tags = { Name: `asistencia-${tenant.id}-${origen}`, Proyecto: 'asistencia', Componente: 'tenant', Tenant: tenant.id,
    Entorno: tenant.entorno, Plan: tenant.plan, Origen: origen, ExpiraEn: expira, SolicitadoPor: usuario || 'plataforma' };
  const especificacion = `ResourceType=snapshot,Tags=[${Object.entries(tags).map(([k, v]) => `{Key=${k},Value=${String(v).replace(/[,{}\[\]=]/g, '_')}}`).join(',')}]`;
  registro?.linea(`Volumen de datos ${vol.VolumeId} (${vol.Size} GB, ${vol.State === 'in-use' ? 'conectado' : vol.State})`);
  const s = await aws(['ec2', 'create-snapshot', '--volume-id', vol.VolumeId,
    '--description', `Respaldo ${origen} de ${tenant.id}`, '--tag-specifications', especificacion]);
  registro?.linea(`Snapshot ${s.SnapshotId} iniciado; vence el ${expira.slice(0, 10)} (${dias} días del plan)`);
  // Espera a que se complete (el primero de un volumen tarda más; luego son incrementales)
  const limite = Date.now() + 30 * 60 * 1000;
  for (;;) {
    const d = await aws(['ec2', 'describe-snapshots', '--snapshot-ids', s.SnapshotId]);
    const snap = (d.Snapshots || [])[0];
    if (snap?.State === 'completed') { registro?.linea(`Snapshot ${s.SnapshotId} completado`); return { id: s.SnapshotId, volumen: vol.VolumeId, expira }; }
    if (snap?.State === 'error') throw new Error(`El snapshot ${s.SnapshotId} terminó con error`);
    if (Date.now() > limite) throw new Error(`El snapshot ${s.SnapshotId} no terminó en 30 minutos`);
    registro?.linea(`  progreso ${snap?.Progress || '0%'}`);
    await new Promise((r) => setTimeout(r, 15000));
  }
}

// Borra los snapshots propios (a pedido y previos a restaurar) cuya fecha ExpiraEn ya pasó
async function purgarVencidos() {
  const r = await aws(['ec2', 'describe-snapshots', '--owner-ids', 'self', '--filters',
    'Name=tag:Componente,Values=tenant', `Name=tag:Origen,Values=${ORIGENES_PROPIOS.join(',')}`]);
  const borrados = [];
  for (const s of r.Snapshots || []) {
    const expira = tag(s, 'ExpiraEn');
    if (expira && new Date(expira) < new Date()) {
      await aws(['ec2', 'delete-snapshot', '--snapshot-id', s.SnapshotId]);
      borrados.push(`${s.SnapshotId} (${tag(s, 'Tenant')})`);
    }
  }
  return borrados;
}

module.exports = { listar, crear, purgarVencidos, volumenDatos, aws };
