// Catálogo de planes: fuente única en catalogo/planes.json
const fs = require('fs');
const path = require('path');

const RUTA = path.resolve(__dirname, '..', 'catalogo', 'planes.json');

function leerCatalogo() {
  // Se relee en cada uso para que un cambio en el JSON no exija reiniciar
  return JSON.parse(fs.readFileSync(RUTA, 'utf8'));
}

function obtenerPlan(id) {
  return leerCatalogo().planes.find((p) => p.id === id) || null;
}

// Variables que recibe el módulo tenant de asistencia-infra
function variablesTenant(tenant, plan, { suspendido = false, appVersion } = {}) {
  return {
    tenant_id: tenant.id,
    entorno: tenant.entorno,
    plan: plan.id,
    motor: tenant.motor === 'opentofu' ? 'opentofu' : 'terraform',
    instance_type: plan.infra.instance_type,
    root_volume_gb: plan.infra.root_volume_gb,
    data_volume_gb: plan.infra.data_volume_gb,
    limites: {
      estudiantes: plan.limites.estudiantes,
      docentes: plan.limites.docentes,
      cursos: plan.limites.cursos,
    },
    app_version: appVersion || tenant.app_version || 'main',
    suspendido,
  };
}

module.exports = { leerCatalogo, obtenerPlan, variablesTenant };
