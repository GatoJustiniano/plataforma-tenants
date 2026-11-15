# Respaldos y restauración (RF-19)

Lo que se respalda es el **volumen de datos** de cada tenant: el EBS cifrado montado en `/var/lib/asistencia`, donde vive su base SQLite. El disco del sistema no se respalda, porque se reconstruye solo (AMI de Packer y cloud-init).

## Política por plan

Sale de `operacion` en `catalogo/planes.json`:

| Plan | Frecuencia | Se guarda |
|---|---|---|
| Básico | semanal (domingos) | 7 días |
| Estándar | diario | 14 días |
| Avanzado | diario | 30 días |

La hora es las 06:00 UTC, que son las 02:00 en Bolivia.

## Tres tipos de respaldo

| Origen | Quién lo crea | Cuándo vence |
|---|---|---|
| **programado** | AWS Data Lifecycle Manager (DLM) | A los días del plan; lo borra DLM |
| **a pedido** | El worker, con el botón *Respaldar ahora* | A los días del plan; lo borra el worker (revisa cada hora el tag `ExpiraEn`) |
| **antes de restaurar** | El worker, automáticamente antes de cada restauración | Igual que el anterior |

Todos los snapshots llevan los tags del tenant (`Tenant`, `Plan`, `Entorno`, `Componente=tenant`) y `Origen`. Así el panel los encuentra y el worker puede restaurarlos o borrarlos, pero no tocar otros.

### Programados: AWS Data Lifecycle Manager

`infra/plataforma` crea **una política de DLM por plan**, a partir del catálogo (`aws_dlm_lifecycle_policy.respaldos`). Cada política respalda los volúmenes con el tag `Respaldo=<plan>`, que el módulo `tenant` pone **solo en el volumen de datos**. No hay cron ni proceso propio: AWS ejecuta y expira los respaldos aunque la plataforma esté apagada.

El rol de DLM se llama `asistencia-plataforma-dlm` y usa la política administrada `AWSDataLifecycleManagerServiceRole`. Su nombre empieza por `asistencia-plataforma-`, así que el `Deny` del worker lo protege.

Si cambia la frecuencia o la retención en el catálogo, basta con un `terraform apply` en `infra/plataforma`. Si un tenant cambia de plan, su volumen cambia el tag `Respaldo` y pasa a la otra política.

### Consistencia

Los snapshots de EBS son *crash-consistent*: equivalen al disco tras un corte de luz. SQLite está diseñado para recuperarse de eso: si el snapshot captura una escritura a medias, al abrir la base usa su archivo de diario (*rollback journal*) para deshacerla. Por eso no se detiene la app para respaldar.

## Restaurar

Desde el detalle del tenant, en **Respaldos → Restaurar…**: se elige el snapshot y se confirma escribiendo el identificador del tenant, como al eliminar (RF-18). Solo se permite con el tenant activo, sin otra operación en curso y creado con Terraform u OpenTofu. Los tenants de CloudFormation se respaldan igual, pero la implementación reducida no restaura.

El worker:

1. **Crea un respaldo de los datos actuales** (origen *antes de restaurar*), para poder deshacer la restauración.
2. Ejecuta el motor con `-replace=module.tenant.aws_ebs_volume.datos` y `snapshot_datos=<snap>`:
   - `aws_volume_attachment` tiene `stop_instance_before_detaching`: la instancia se detiene antes de desconectar el volumen, así no se corrompe SQLite.
   - Se crea un volumen nuevo desde el snapshot. El sistema de archivos conserva su UUID, así que se monta sin formatear.
   - Como cambia el id del volumen, la instancia se recrea y cloud-init monta el volumen restaurado e instala la app.
3. Espera a que `/api/health` responda y deja registrados el snapshot restaurado y el respaldo previo (RF-13).

El volumen tiene `ignore_changes = [snapshot_id]`, así que las operaciones siguientes, que ya no envían `snapshot_datos`, no lo vuelven a reemplazar.

Si algo falla, el tenant queda *fallido* y **Reintentar** repite la restauración con el mismo snapshot (RF-12). Para deshacer una restauración, se restaura el respaldo *antes de restaurar*.

## Al eliminar un tenant

Los snapshots **no se borran con el tenant**: se conservan hasta su vencimiento, como dice la política de retención (`docs/planes.md`).

- Los propios (a pedido y antes de restaurar) los borra el worker al vencer.
- Los programados que ya existían quedan hasta que se borren a mano. DLM deja de crear nuevos porque el volumen ya no existe.

## Permisos

| Quién | Puede |
|---|---|
| DLM | Crear y borrar snapshots de los volúmenes con `Respaldo=<plan>` |
| Worker | `CreateSnapshot` solo de volúmenes `Componente=tenant`, y el snapshot debe nacer con ese tag. `DeleteSnapshot` solo de snapshots `Componente=tenant`. Crear el volumen desde el snapshot entra en sus permisos de creación de volúmenes |
| Tenant | Nada: su rol no tiene permisos de EC2 (ver [aislamiento.md](aislamiento.md)) |

## API

| Método y ruta | Qué hace |
|---|---|
| `GET /api/tenants/:id/respaldos` | Política del plan y snapshots del tenant (fecha, origen, estado, vencimiento) |
| `POST /api/tenants/:id/respaldar` | Encola un respaldo a pedido (tenant activo o suspendido) |
| `POST /api/tenants/:id/restaurar` | `{snapshot_id, confirmacion: "<id del tenant>"}`. Encola la restauración |
