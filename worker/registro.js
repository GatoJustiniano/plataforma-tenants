// Registro de una operación en curso: paso actual y log saneado, escritos en la BD
// cada segundo para que la API pueda mostrar el progreso (RF-11).
const { spawn } = require('child_process');
const { db } = require('../comun/db');
const { sanitizar } = require('../comun/sanitizar');

class Registro {
  constructor(opId) {
    this.opId = opId;
    this.buffer = '';
    this.parcial = '';           // línea incompleta: se sanea solo cuando llega entera
    this.timer = setInterval(() => this.flush(), 1000);
  }

  paso(texto) {
    db.prepare('UPDATE operaciones SET paso = ? WHERE id = ?').run(texto, this.opId);
    this.linea(`\n==> ${texto}`);
  }

  linea(texto) { this.escribir(`${texto}\n`); }

  escribir(chunk) {
    const todo = this.parcial + chunk;
    const corte = todo.lastIndexOf('\n');
    if (corte === -1) { this.parcial = todo; return; }
    this.buffer += sanitizar(todo.slice(0, corte + 1));
    this.parcial = todo.slice(corte + 1);
  }

  flush() {
    if (!this.buffer) return;
    db.prepare('UPDATE operaciones SET log = log || ? WHERE id = ?').run(this.buffer, this.opId);
    this.buffer = '';
  }

  cerrar() {
    if (this.parcial) { this.buffer += sanitizar(this.parcial + '\n'); this.parcial = ''; }
    clearInterval(this.timer);
    this.flush();
  }

  // Ejecuta un comando y vuelca su salida al log. Devuelve stdout completo (sin sanear,
  // para poder leer JSON); falla si el código de salida no es 0.
  ejecutar(cmd, args, { cwd, env, mostrar = true, capturar = false } = {}) {
    if (mostrar) this.linea(`$ ${cmd} ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
      let out = ''; let errOut = '';
      p.stdout.on('data', (d) => { const s = d.toString(); if (capturar) out += s; else this.escribir(s); });
      p.stderr.on('data', (d) => { const s = d.toString(); errOut += s; this.escribir(s); });
      p.on('error', (e) => reject(Object.assign(new Error(`No se pudo ejecutar "${cmd}": ${e.message}`), { salida: errOut })));
      p.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(Object.assign(new Error(`"${cmd} ${args[0] || ''}" terminó con código ${code}`), { salida: errOut }));
      });
    });
  }
}

module.exports = { Registro };
