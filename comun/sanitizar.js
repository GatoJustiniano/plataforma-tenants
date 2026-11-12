// Quita secretos de cualquier texto antes de guardarlo o mostrarlo
// (requisito: "Mostrar los errores sin exponer secretos").
const PATRONES = [
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '$1****************'],                          // access key id
  [/(aws_secret_access_key|aws_session_token)\s*[=:]\s*\S+/gi, '$1=****'],
  [/(ADMIN_KEY|PASSWORD|PASSWD|SECRET|TOKEN)(["']?\s*[=:]\s*["']?)[^\s"',]+/gi, '$1$2****'],
  [/("value"\s*:\s*)"[^"]*"(?=[^}]*"sensitive"\s*:\s*true)/g, '$1"****"'],         // outputs sensibles
  [/\x1b\[[0-9;]*m/g, ''],                                                        // colores ANSI
];

function sanitizar(texto) {
  let t = String(texto ?? '');
  for (const [re, rep] of PATRONES) t = t.replace(re, rep);
  return t;
}

module.exports = { sanitizar };
