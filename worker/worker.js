// Worker: ejecuta en segundo plano las operaciones que registra la API.
// Toma una operación pendiente a la vez (así nunca hay dos sobre el mismo tenant)
// y deja en la BD el paso actual, el log saneado, el resultado y las versiones usadas.
const fs = require('fs');
const path = require('path');
const { db, TIPOS_OPERACION, ahora } = require('../comun/db');
const { obtenerPlan, variablesTenant } = require('../comun/catalogo');
const { Registro } = require('./registro');
const { prepararPlantillas } = require('./plantillas');
const { mensajeError } = require('./errores');
const { crearMotor } = require('./motores/terraform');

// En la EC2 el código es de solo lectura: las carpetas de trabajo van en TRABAJOS_DIR (/var/lib/plataforma)
const TRABAJOS = process.env.TRABAJOS_DIR ? path.resolve(process.env.TRABAJOS_DIR) : path.resolve(__dirname, 'trabajos');
const INTERVALO_MS = 2000;
const HEALTH_TIMEOUT_S = Number(process.env.HEALTH_TIMEOUT_S) || 600;

const MOTORES = {
  terraform: () => crearMotor('terraform'),
  opentofu: () => crearMotor('opentofu'),
  // pulumi y cloudformation: se agregan como implementaciones reducidas más adelante
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function actualizarTenant(id, campos) {
  const claves = Object.keys(campos);
  db.prepare(`UPDATE tenants SET ${claves.map((k) => `${k} = ?`).join(', ')}, actualizado_en = ? WHERE id = ?`)
    .run(...claves.map((k) => campos[k]), ahora(), id);
}

function terminar(op, estado, extra = {}) {
  db.prepare(`UPDATE operaciones SET estado = ?, paso = ?, error = ?, resultado = ?, versiones = ?, terminada_en = ? WHERE id = ?`)
    .run(estado, extra.paso || null, extra.error || null,
      extra.resultado ? JSON.stringify(extra.resultado) : null,
      extra.versiones ? JSON.stringify(extra.versiones) : null, ahora(), op.id);
}

async function esperarSalud(url, reg) {
  const limite = Date.now() + HEALTH_TIMEOUT_S * 1000;
  let intento = 0;
  while (Date.now() < limite) {
    intento++;
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) { reg.linea(`Health check OK (intento ${intento})`); return; }
    } catch { /* todavía arrancando */ }
    if (intento % 6 === 1) reg.linea(`Esperando a que la app responda en ${url}/api/health ...`);
    await dormir(10000);
  }
  throw new Error(`La app no respondió en ${HEALTH_TIMEOUT_S}s (did not respond)`);
}

async function ejecutar(op) {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(op.tenant_id);
  const reg = new Registro(op.id);
  const dir = path.join(TRABAJOS, `op-${op.id}`);
  const versiones = { app: tenant.app_version };
  reg.linea(`Operación #${op.id} "${op.tipo}" sobre el tenant ${tenant.id} (motor ${tenant.motor}, plan ${tenant.plan})`);

  try {
    const fabrica = MOTORES[tenant.motor];
    if (!fabrica) throw new Error(`El motor "${tenant.motor}" todavía no está implementado en el worker`);
    const motor = fabrica();
    const plan = obtenerPlan(tenant.plan);
    if (!plan) throw new Error(`El plan "${tenant.plan}" ya no existe en el catálogo`);

    reg.paso('Preparando plantillas');
    versiones.plantillas = await prepararPlantillas(dir, reg);
    const raiz = path.join(dir, 'terraform');
    const suspendido = op.tipo === 'suspender';
    fs.writeFileSync(path.join(raiz, 'tenant.tfvars.json'),
      JSON.stringify(variablesTenant(tenant, plan, { suspendido }), null, 2));

    reg.paso('Inicializando el motor y el estado remoto');
    await motor.init(reg, raiz, tenant.id);
    versiones.motor = await motor.version(reg, raiz);

    if (op.tipo === 'plan_eliminar') {
      reg.paso('Calculando qué se eliminará');
      const recursos = await motor.planDestroy(reg, raiz, 'tenant.tfvars.json');
      const datos = recursos.filter((r) => ['aws_ebs_volume', 'aws_ssm_parameter'].includes(r.tipo));
      terminar(op, 'esperando_confirmacion', {
        paso: `Esperando confirmación: se eliminarán ${recursos.length} recursos`,
        resultado: { recursos, datos, aviso: 'El volumen de datos (base SQLite) y los secretos del tenant se borrarán de forma permanente.' },
        versiones,
      });
      return;
    }

    if (op.tipo === 'eliminar') {
      reg.paso('Eliminando recursos');
      await motor.destroy(reg, raiz, 'tenant.tfvars.json');
      actualizarTenant(tenant.id, { estado: 'eliminado', url: null, instance_id: null });
      terminar(op, 'exitosa', { paso: 'Tenant eliminado', versiones });
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }

    // crear | suspender | reanudar: todas son un apply sobre el mismo estado (idempotente)
    reg.paso(suspendido ? 'Deteniendo la instancia' : 'Aplicando la infraestructura');
    await motor.apply(reg, raiz, 'tenant.tfvars.json');
    const outputs = await motor.outputs(reg, raiz);
    if (outputs.ami_id) versiones.ami = outputs.ami_id; // AMI de Packer usada (RF-13)

    if (!suspendido) {
      reg.paso('Esperando a que la aplicación responda');
      await esperarSalud(outputs.url_app, reg);
    }

    actualizarTenant(tenant.id, {
      estado: TIPOS_OPERACION[op.tipo].exito,
      url: outputs.url_app || null,
      instance_id: outputs.instance_id || null,
    });
    terminar(op, 'exitosa', { paso: 'Completada', resultado: { outputs }, versiones });
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    const mensaje = mensajeError(e);
    reg.linea(`\nERROR: ${mensaje}`);
    actualizarTenant(tenant.id, { estado: 'fallido' });
    terminar(op, 'fallida', { paso: 'Falló', error: mensaje, versiones });
    // la carpeta de trabajo se conserva para diagnóstico
  } finally {
    reg.cerrar();
  }
}

function recuperarInterrumpidas() {
  const ops = db.prepare("SELECT * FROM operaciones WHERE estado = 'en_curso'").all();
  for (const op of ops) {
    terminar(op, 'fallida', { paso: 'Interrumpida', error: 'El worker se detuvo durante la operación. Reintenta: el motor retomará desde el estado guardado.' });
    actualizarTenant(op.tenant_id, { estado: 'fallido' });
    console.warn(`Operación #${op.id} marcada como fallida (interrumpida)`);
  }
}

// Un solo worker a la vez: si arrancaran dos, el segundo marcaría como interrumpidas
// las operaciones que el primero está ejecutando.
const CANDADO = path.join(TRABAJOS, 'worker.pid');
function tomarCandado() {
  try {
    const pid = Number(fs.readFileSync(CANDADO, 'utf8'));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // lanza si el proceso ya no existe
      console.error(`Ya hay un worker en ejecución (PID ${pid}). Detenlo antes de iniciar otro.`);
      process.exit(1);
    }
  } catch { /* sin candado o el proceso anterior ya terminó */ }
  fs.writeFileSync(CANDADO, String(process.pid));
  process.on('exit', () => { try { if (Number(fs.readFileSync(CANDADO, 'utf8')) === process.pid) fs.rmSync(CANDADO); } catch { /* nada */ } });
}

// Toma la siguiente operación pendiente en una sola sentencia (atómica)
const tomarSiguiente = db.prepare(`UPDATE operaciones SET estado = 'en_curso', iniciada_en = ?
  WHERE id = (SELECT id FROM operaciones WHERE estado = 'pendiente' ORDER BY id LIMIT 1) RETURNING *`);

async function bucle() {
  fs.mkdirSync(TRABAJOS, { recursive: true });
  tomarCandado();
  recuperarInterrumpidas();
  console.log(`Worker listo. Plantillas: ${process.env.INFRA_DIR || `${process.env.INFRA_REPO}@${process.env.INFRA_REF || 'main'}`}`);
  let detener = false;
  process.on('SIGINT', () => { console.log('Deteniendo al terminar la operación actual...'); detener = true; });

  while (!detener) {
    const op = tomarSiguiente.get(ahora());
    if (!op) { await dormir(INTERVALO_MS); continue; }
    console.log(`→ #${op.id} ${op.tipo} ${op.tenant_id}`);
    await ejecutar(op);
    const fin = db.prepare('SELECT estado, error FROM operaciones WHERE id = ?').get(op.id);
    console.log(`← #${op.id} ${fin.estado}${fin.error ? `: ${fin.error}` : ''}`);
  }
  process.exit(0);
}

bucle();
