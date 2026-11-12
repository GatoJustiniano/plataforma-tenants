// Prepara una copia de asistencia-infra para una operación y anota de dónde salió (RF-13).
const fs = require('fs');
const path = require('path');

const EXCLUIR = /(^|[\\/])(\.git|\.terraform|node_modules|bin)([\\/]|$)|\.tfstate(\.|$)|tenant\.tfvars\.json$/;

async function prepararPlantillas(destino, registro) {
  fs.rmSync(destino, { recursive: true, force: true });
  const infraDir = process.env.INFRA_DIR ? path.resolve(__dirname, '..', process.env.INFRA_DIR) : '';

  if (infraDir) {
    registro.linea(`Plantillas desde carpeta local: ${infraDir}`);
    fs.cpSync(infraDir, destino, { recursive: true, filter: (src) => !EXCLUIR.test(path.relative(infraDir, src)) });
    const commit = (await registro.ejecutar('git', ['-C', infraDir, 'rev-parse', 'HEAD'], { capturar: true, mostrar: false })).trim();
    const cambios = (await registro.ejecutar('git', ['-C', infraDir, 'status', '--porcelain'], { capturar: true, mostrar: false })).trim();
    return { origen: 'local', ref: null, commit, cambios_sin_commit: cambios.length > 0 };
  }

  const repo = process.env.INFRA_REPO;
  const ref = process.env.INFRA_REF || 'main';
  await registro.ejecutar('git', ['clone', '--depth', '1', '--branch', ref, repo, destino]);
  const commit = (await registro.ejecutar('git', ['-C', destino, 'rev-parse', 'HEAD'], { capturar: true, mostrar: false })).trim();
  return { origen: repo, ref, commit, cambios_sin_commit: false };
}

module.exports = { prepararPlantillas };
