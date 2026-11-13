// Lee las reglas y alertas de Grafana para mostrarlas en el panel (RF-29).
// El token de la cuenta de servicio (rol Viewer) lo crea Ansible y lo guarda en SSM; aquí
// se lee de GRAFANA_TOKEN o, si está vacía, de SSM con las credenciales AWS de la plataforma.
// Nunca se devuelve al navegador.
const { execFile } = require('child_process');

const URL_GRAFANA = (process.env.GRAFANA_URL || '').replace(/\/$/, '');
// URL para los enlaces del navegador. En la EC2 la API habla con Grafana por localhost,
// pero el navegador necesita la IP pública.
const URL_PUBLICA = (process.env.GRAFANA_URL_PUBLICA || URL_GRAFANA).replace(/\/$/, '');
const TOKEN_SSM = process.env.GRAFANA_TOKEN_SSM || '/asistencia/plataforma/grafana-token';
const REGION = process.env.AWS_REGION || 'us-east-1';
const CACHE_MS = 15000;

let token = process.env.GRAFANA_TOKEN || '';
let cache = { en: 0, datos: null };

function leerTokenSsm() {
  return new Promise((ok, ko) => {
    execFile('aws', ['ssm', 'get-parameter', '--region', REGION, '--with-decryption', '--name', TOKEN_SSM,
      '--query', 'Parameter.Value', '--output', 'text'], { timeout: 20000, windowsHide: true }, (e, stdout) => {
      if (e) return ko(new Error(`No se pudo leer el token de Grafana desde SSM (${TOKEN_SSM})`));
      ok(stdout.trim());
    });
  });
}

async function pedir(ruta) {
  if (!token) token = await leerTokenSsm();
  let r;
  try {
    r = await fetch(`${URL_GRAFANA}${ruta}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error(`Grafana no responde en ${URL_GRAFANA}`);
  }
  if (r.status === 401) { token = ''; throw new Error('Grafana rechazó el token (401)'); }
  if (!r.ok) throw new Error(`Grafana respondió ${r.status}`);
  return r.json();
}

// Convierte la respuesta de /api/prometheus/grafana/api/v1/rules en algo fácil de pintar
function normalizar(json) {
  const reglas = [];
  for (const g of json?.data?.groups || []) {
    for (const r of g.rules || []) {
      reglas.push({
        titulo: r.name,
        estado: r.state, // inactive | pending | firing
        salud: r.health, // ok | nodata | error
        severidad: r.labels?.severidad || '',
        alertas: (r.alerts || []).map((a) => ({
          tenant: a.labels?.tenant || '',
          entorno: a.labels?.entorno || '',
          plan: a.labels?.plan || '',
          estado: String(a.state || '').toLowerCase().startsWith('alerting') ? 'firing' : String(a.state || '').toLowerCase(),
          desde: a.activeAt,
          valor: a.value,
          resumen: a.annotations?.summary || '',
        })).filter((a) => a.estado === 'firing' || a.estado === 'pending'),
      });
    }
  }
  return reglas;
}

async function monitoreo() {
  if (!URL_GRAFANA) return { configurado: false };
  if (cache.datos && Date.now() - cache.en < CACHE_MS) return cache.datos;
  const base = { configurado: true, grafana_url: URL_PUBLICA, dashboard_url: `${URL_PUBLICA}/d/asistencia-tenants` };
  try {
    const reglas = normalizar(await pedir('/api/prometheus/grafana/api/v1/rules'));
    cache = { en: Date.now(), datos: { ...base, reglas, actualizado: new Date().toISOString() } };
  } catch (e) {
    return { ...base, error: e.message };
  }
  return cache.datos;
}

module.exports = { monitoreo };
