# Matriz de requisitos

Cada requisito de *Requisitos del proyecto final* (v2), dónde está implementado y cómo se comprobó. Los requisitos tachados en el enunciado se marcan como **tachado**, aunque varios se implementaron igual.

| Marca | Significado |
|---|---|
| ✅ | Cumple y se probó en AWS |
| ◐ | Cumple en parte (se explica) |
| — | Tachado en el enunciado |

Los tres repositorios: **plataforma-tenants** (panel, API, worker, infraestructura de la plataforma, Ansible y documentación), **asistencia-infra** (plantillas de un tenant: Terraform/OpenTofu, cloud-init y Packer) y **asistencia-app** (la aplicación).

## 3. Requisitos funcionales

### Catálogo de planes

| Req. | Estado | Implementación | Evidencia |
|---|---|---|---|
| RF-01 Catálogo de planes | ✅ | [catalogo/planes.json](../catalogo/planes.json): Básico, Estándar y Avanzado. Vista *Planes* y `GET /api/planes` | [planes.md](planes.md) |
| RF-02 Recursos de cada plan | ✅ | Cómputo (`instance_type`, vCPU, memoria), discos, tamaño del volumen de la base de datos y límites (estudiantes, docentes, cursos, importación) | [planes.md](planes.md#resumen) |
| RF-03 Elegir plan y ver sus características | ✅ | Paso 2 del asistente *Crear tenant*: tarjetas con recursos, límites y costo | Panel en línea |
| RF-04 Consultar y modificar planes | — | Se consultan en el panel; se modifican editando `planes.json` (versionado en git) y aplicando | [planes.md](planes.md) |
| RF-05 Impedir exceder límites | — | Infraestructura (CPU, memoria y disco del plan) + alertas al 90 % de estudiantes y al 80 % de disco; la app expone los límites como métricas | [planes.md](planes.md#límites-de-uso-rf-05) |
| RF-06 Cambiar el plan de un tenant | — | No implementado | — |

### Creación y despliegue

| Req. | Estado | Implementación | Evidencia |
|---|---|---|---|
| RF-07 Crear con nombre, id, contacto, entorno y plan | ✅ | Asistente de 3 pasos y `POST /api/tenants` (id validado y único; los ids `plataforma` y `limite` están reservados) | Tenants creados en los tres planes |
| RF-08 Elegir el motor | ◐ | **Terraform y OpenTofu** funcionan con las mismas plantillas. Pulumi y CloudFormation aparecen deshabilitados; en su lugar hay una comparación técnica, que el enunciado (sección 4) admite | `colegio-tofu` creado con OpenTofu 1.13.9; [arquitectura.md §6](arquitectura.md#6-comparación-técnica-de-los-motores) |
| RF-09 Recursos para frontend, backend y BD | ✅ | Módulo `tenant`: EC2, volumen EBS de datos, SG, rol IAM y secreto en SSM | [asistencia-infra/terraform](../../asistencia-infra/terraform) |
| RF-10 Desplegar la app y conectarla a su BD | ✅ | cloud-init monta el volumen, escribe `DB_PATH=/var/lib/asistencia/asistencia.db` y arranca la app | `/api/health` 200 en cada creación |
| RF-11 Progreso, resultado y errores comprensibles | ✅ | Paso actual y log en vivo; [worker/errores.js](../worker/errores.js) traduce los errores del motor | "El worker no tiene permisos IAM…", "La cuenta AWS está en el plan gratuito…" |
| RF-12 Reintentar sin duplicar | ✅ | **Reintentar** vuelve a ejecutar `apply` sobre el mismo estado en S3 | Dos fallos reales reintentados: "4 to add" y "3 to add" sobre lo ya creado |
| RF-13 Versiones usadas | ✅ | Cada operación guarda la versión de la app, el origen y commit de las plantillas, el motor, los providers y la AMI | Detalle de cada operación |

### Ciclo de vida del tenant

| Req. | Estado | Implementación | Evidencia |
|---|---|---|---|
| RF-14 Consultar por nombre, estado, plan y entorno | ✅ | Filtros en *Tenants* y `GET /api/tenants?nombre=&estado=&plan=&entorno=` | Panel |
| RF-15 Actualizar app e infraestructura | — | No hay botón propio. Cada operación aplica las plantillas y el catálogo vigentes; ver [operacion.md](operacion.md#actualizar-un-tenant) | — |
| RF-16 Suspender y reanudar | ✅ | Detiene y arranca la EC2 (`aws_ec2_instance_state`) | Probado con varios tenants |
| RF-17 Suspensión con política de retención | ✅ | Se detiene la EC2 y se conserva el volumen. El panel muestra hasta cuándo se garantizan los datos y marca **retención vencida** pasado el plazo del plan (30, 90 o 180 días) | [planes.md](planes.md#política-de-suspensión-y-retención-rf-16-rf-17) |
| RF-18 Mostrar qué se elimina y confirmar | ✅ | `plan -destroy` → lista de recursos, con los datos marcados → se confirma escribiendo el id | Eliminaciones de `colegio-nombre` y `colegio-respaldo` (16 recursos) |
| RF-19 Respaldar y restaurar | — ✅ | Tachado, pero implementado: DLM por plan, respaldo a pedido y restauración con respaldo previo | [respaldos.md](respaldos.md); prueba: los datos cambiados volvieron al estado del respaldo |
| RF-20 Quién, cuándo y resultado | — ✅ | Tachado, pero implementado: vista *Auditoría* (solicitante, fechas, duración, resultado, log) | Panel |

### Aplicación

| Req. | Estado | Implementación | Evidencia |
|---|---|---|---|
| RF-21 Requisitos actuales de la app | ✅ | La app se despliega sin cambios funcionales; solo se agregó el nombre de la institución como título y las métricas | [asistencia-app](../../asistencia-app) |

El enunciado salta de RF-21 a RF-25: no existen RF-22 a RF-24.

### Salud, métricas y alertas

| Req. | Estado | Implementación | Evidencia |
|---|---|---|---|
| RF-25 Grafana por tenant | ✅ | Dashboard `asistencia-tenants`, aprovisionado por Ansible | [monitoreo.md](monitoreo.md) |
| RF-26 Disponibilidad, CPU, memoria, latencia, errores, estado de la BD | ✅ | blackbox (`/api/health`), node_exporter, `prom-client` en la app (5xx, latencia p95, `asistencia_db_up`) | Dashboard de 10 paneles |
| RF-27 Por tenant y por entorno | ✅ | Variables `entorno`, `plan` y `tenant` del dashboard (tags de EC2 → etiquetas) | Dashboard |
| RF-28 Alertas: caída, errores, límites | ✅ | 7 reglas: servicio caído, BD caída, 5xx, CPU, memoria, disco y límite de estudiantes. Umbrales desde el catálogo | Prueba: app detenida → *disparada* a los 2 min → resuelta |
| RF-29 Alertas en la plataforma con tenant y hora | ✅ | Vista *Monitoreo* y detalle del tenant, por la API de Grafana (token de solo lectura) | [monitoreo.md](monitoreo.md#alertas-en-la-plataforma-rf-29) |

## 4. Uso de tecnologías

| Herramienta | Estado | Dónde |
|---|---|---|
| Terraform / OpenTofu | ✅ | `asistencia-infra/terraform`, `infra/*` |
| Pulumi y CloudFormation | ◐ | Comparación técnica en [arquitectura.md §6](arquitectura.md#6-comparación-técnica-de-los-motores), que el enunciado acepta ("o comparación técnica"). No hay una segunda implementación funcionando |
| cloud-init | ✅ | `asistencia-infra/cloud-init`, `infra/plataforma/cloud-init.yaml` |
| Ansible | ✅ | `ansible/`: configuración posterior de la EC2 de la plataforma |
| Packer | ✅ | `asistencia-infra/packer`: AMI de los tenants |
| Grafana | ✅ | `ansible/roles/grafana` |
| Explicar la función de cada una | ✅ | [arquitectura.md §4](arquitectura.md#4-función-de-cada-herramienta) |

## 5. Requisitos no funcionales

| Requisito | Estado | Cómo | Evidencia |
|---|---|---|---|
| Datos aislados por tenant | ✅ | EC2, volumen, SG, rol IAM y secreto por tenant; permissions boundary por tag `Tenant` | [aislamiento.md](aislamiento.md) (incluye un hallazgo corregido) |
| Secretos fuera del código | ✅ | SSM SecureString generado por Terraform; `.env` y `terraform.tfvars` ignorados por git; el worker usa el rol de la instancia | [arquitectura.md §5](arquitectura.md#5-decisiones-y-requisitos-no-funcionales) |
| Trabajos en segundo plano y consulta de su estado | ✅ | La API responde `202`; el worker procesa la cola; `GET /api/operaciones/:id` | Panel |
| Historial de operaciones y resultados | ✅ | Tabla `operaciones` con log, resultado y versiones; vista *Auditoría* | Panel |
| Operaciones repetibles | ✅ | `apply` idempotente sobre el mismo estado; reintento sin duplicar; lock de S3 | RF-12 |
| Documentar el estado del motor | ✅ | [infra/README.md](../infra/README.md#cómo-se-guarda-y-protege-el-estado) | — |
| Errores sin secretos | ✅ | [comun/sanitizar.js](../comun/sanitizar.js) en todo log; los valores `sensitive` se muestran como `****` | Logs de las operaciones |
| Detener o eliminar recursos de prueba | ✅ | Suspender o eliminar desde el panel; apagar la plataforma | [operacion.md](operacion.md#costos-y-apagado) |

## 6. Entregables

| # | Entregable | Dónde |
|---|---|---|
| 1 | Código del frontend y backend | `plataforma-tenants` (panel y API) y `asistencia-app` |
| 2 | Código de infraestructura y configuración | `asistencia-infra` (tenant, cloud-init, Packer), `plataforma-tenants/infra` y `ansible` |
| 3 | Diagrama de arquitectura y flujo de creación | [arquitectura.md](arquitectura.md) |
| 4 | Catálogo de planes y límites | [planes.md](planes.md) y `catalogo/planes.json` |
| 5 | Tablero de Grafana con métricas y alertas | `ansible/roles/grafana/files/tenants.json`, `templates/alertas.yml.j2` y [monitoreo.md](monitoreo.md) |
| 6 | Instrucciones para crear, actualizar, suspender, reanudar, respaldar, restaurar y eliminar | [operacion.md](operacion.md) |
| 7 | Evidencia de aislamiento | [aislamiento.md](aislamiento.md) |
| 8 | Demostración y presentación | Guion de la demo en [operacion.md](operacion.md#guion-de-la-demostración) |

## 7. Criterios mínimos de aceptación

| Criterio | Estado | Cómo demostrarlo |
|---|---|---|
| Crear tenants con distintos planes | ✅ | Asistente; se crearon tenants Básico, Estándar y Avanzado |
| Desplegar frontend, backend y BD por tenant | ✅ | Abrir la URL del tenant (login de la app); volumen montado en `/var/lib/asistencia` |
| Cambiar el plan de un tenant | — | Tachado (RF-06 no implementado) |
| Suspender y reanudar conservando los datos | ✅ | Suspender → EC2 detenida y volumen conservado → reanudar → mismos datos |
| Respaldar y restaurar | — ✅ | Tachado, pero se puede mostrar: *Respaldar ahora* → cambiar datos → *Restaurar* |
| Grafana con la salud y una alerta de ejemplo | ✅ | Detener la app de un tenant → *Servicio caído* se dispara en unos 2 min (guion de la demo) |
| Un tenant no puede consultar datos de otro | ✅ | [aislamiento.md](aislamiento.md) y [evidencias/prueba-aislamiento.sh](evidencias/prueba-aislamiento.sh) |
| Historial de una operación fallida y reintento | — ✅ | Tachado, pero probado dos veces |

## Pendiente y fuera de alcance

- **RF-08 completo:** Pulumi o CloudFormation como motor funcionando en el worker (hoy solo hay comparación técnica).
- **RF-06 y RF-15** (tachados): cambio de plan y una operación propia de "actualizar".
- **Portal sin HTTPS:** se abre solo desde las IPs de administración y pide clave, pero la clave viaja sin cifrar.
- **Administrador del tenant:** administra su institución en la app (panel docente), pero el estado de sus servicios (Grafana y el panel) solo lo ve el administrador de la plataforma.
