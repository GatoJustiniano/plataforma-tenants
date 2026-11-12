// Traduce errores técnicos del motor a mensajes comprensibles (RF-11), sin secretos.
const { sanitizar } = require('../comun/sanitizar');

const CONOCIDOS = [
  [/VcpuLimitExceeded|InstanceLimitExceeded/i, 'Se alcanzó la cuota de vCPU/instancias de la cuenta AWS. Elimina o suspende tenants, o pide un aumento de cuota.'],
  [/InsufficientInstanceCapacity/i, 'AWS no tiene capacidad para ese tipo de instancia en la zona ahora mismo. Reintenta en unos minutos.'],
  [/ExpiredToken|InvalidClientTokenId|no valid credential sources|SignatureDoesNotMatch/i, 'Las credenciales AWS del worker no son válidas o vencieron.'],
  [/AccessDenied|UnauthorizedOperation|not authorized to perform/i, 'El worker no tiene permisos IAM para una de las acciones de la plantilla.'],
  [/Error acquiring the state lock|ConditionalCheckFailed|PreconditionFailed/i, 'Otra operación está usando el estado de este tenant. Espera a que termine y reintenta.'],
  [/VpcLimitExceeded/i, 'Se alcanzó el límite de VPC de la región.'],
  [/no matching EC2 VPC found|no matching EC2 Security Group found/i, 'No se encontró la red compartida de la plataforma. Aplica primero infra/red.'],
  [/Failed to get existing workspaces|NoSuchBucket/i, 'No se encontró el bucket del estado. Aplica primero infra/bootstrap.'],
  [/Could not retrieve the list of available versions|Failed to query available provider packages/i, 'No se pudieron descargar los providers del motor (¿sin acceso a internet?).'],
  [/ENOENT|No se pudo ejecutar/i, 'No se encontró el binario del motor en el servidor de la plataforma.'],
  [/did not respond|no respondió/i, 'La infraestructura se creó, pero la app no respondió a tiempo. Revisa el log de arranque y reintenta.'],
];

function mensajeError(e) {
  const texto = `${e.message}\n${e.salida || ''}`;
  for (const [re, msg] of CONOCIDOS) if (re.test(texto)) return msg;
  // Si no se reconoce, la primera línea "Error: ..." del motor
  const linea = texto.split('\n').map((l) => l.replace(/^[│╷╵\s]+/, '').trim())
    .find((l) => l.startsWith('Error:'));
  return sanitizar(linea || e.message).slice(0, 500);
}

module.exports = { mensajeError };
