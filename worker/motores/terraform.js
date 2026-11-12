// Motor Terraform / OpenTofu: el mismo HCL de asistencia-infra/terraform, distinto binario.
const fs = require('fs');
const path = require('path');

const CACHE = path.resolve(__dirname, '..', '.cache', 'plugins');

function crearMotor(nombre) {
  const bin = nombre === 'opentofu' ? (process.env.TOFU_BIN || 'tofu') : (process.env.TERRAFORM_BIN || 'terraform');
  fs.mkdirSync(CACHE, { recursive: true });
  const env = {
    TF_IN_AUTOMATION: '1',
    TF_INPUT: '0',
    TF_PLUGIN_CACHE_DIR: CACHE, // no descargar el provider AWS en cada operación
    TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE: 'true',
  };

  return {
    nombre,

    // Después de init, para que incluya las versiones de los providers
    async version(reg, dir) {
      const out = await reg.ejecutar(bin, ['version', '-json'], { cwd: dir, env, capturar: true, mostrar: false });
      const v = JSON.parse(out);
      return { nombre, version: v.terraform_version, providers: v.provider_selections || {} };
    },

    async init(reg, dir, tenantId) {
      await reg.ejecutar(bin, ['init', '-reconfigure', '-no-color', '-input=false',
        `-backend-config=key=tenants/${tenantId}/terraform.tfstate`], { cwd: dir, env });
    },

    async apply(reg, dir, varFile) {
      await reg.ejecutar(bin, ['apply', '-auto-approve', '-no-color', '-input=false', `-var-file=${varFile}`], { cwd: dir, env });
    },

    async outputs(reg, dir) {
      const out = await reg.ejecutar(bin, ['output', '-json', '-no-color'], { cwd: dir, env, capturar: true, mostrar: false });
      return Object.fromEntries(Object.entries(JSON.parse(out || '{}')).map(([k, v]) => [k, v.sensitive ? '****' : v.value]));
    },

    // RF-18: calcula qué se borraría, sin borrar nada
    async planDestroy(reg, dir, varFile) {
      await reg.ejecutar(bin, ['plan', '-destroy', '-no-color', '-input=false', '-out=destruir.plan', `-var-file=${varFile}`], { cwd: dir, env });
      const out = await reg.ejecutar(bin, ['show', '-json', 'destruir.plan'], { cwd: dir, env, capturar: true, mostrar: false });
      const plan = JSON.parse(out);
      return (plan.resource_changes || [])
        .filter((r) => r.mode === 'managed' && r.change.actions.includes('delete'))
        .map((r) => ({ direccion: r.address, tipo: r.type, nombre: (r.change.before && (r.change.before.tags || {}).Name) || r.change.before?.name || r.change.before?.id || null }));
    },

    async destroy(reg, dir, varFile) {
      await reg.ejecutar(bin, ['destroy', '-auto-approve', '-no-color', '-input=false', `-var-file=${varFile}`], { cwd: dir, env });
    },
  };
}

module.exports = { crearMotor };
