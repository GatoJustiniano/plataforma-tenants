# plataforma-tenants

Portal para crear y administrar los tenants de la aplicación de asistencia. Cada tenant es una institución educativa con su propia EC2, su propio volumen de datos SQLite y su propio Security Group.

Este repo forma el sistema completo junto con otros dos:

| Repo | Contenido |
|---|---|
| **plataforma-tenants** (este) | Panel web, API, worker de trabajos, infraestructura de la plataforma, Grafana y documentación |
| [asistencia-app](../asistencia-app) | La aplicación que se despliega en cada tenant |
| [asistencia-infra](../asistencia-infra) | Plantillas de un tenant: Terraform/OpenTofu, Pulumi, CloudFormation, cloud-init, Packer y Ansible |

## Estructura

```
catalogo/   planes.json: catálogo de planes que usan la API y el worker
comun/      BD de la plataforma (SQLite integrado en Node), catálogo y saneo de secretos
frontend/   Panel de administración: Tenants, Planes, Monitoreo, Auditoría
api/        API REST: tenants, planes, operaciones; encola los trabajos
worker/     Ejecuta las operaciones: copia/clona asistencia-infra y corre el motor elegido
infra/      Terraform de la propia plataforma: bucket S3 del estado, VPC compartida, EC2 de la plataforma
ansible/    Playbook de la EC2 de la plataforma: Prometheus, blackbox_exporter y Grafana (paneles y alertas como código)
docs/       Arquitectura, catálogo de planes, instrucciones de operación y evidencias
```

## Ejecutar en local

Requisitos: Node 22.13 o superior, Terraform 1.10 o superior (u OpenTofu), git y el AWS CLI con un perfil configurado. Antes, aplicar una vez `infra/bootstrap` e `infra/red` (ver [infra/README.md](infra/README.md)).

```bash
npm install
```

```bash
cp .env.example .env
```

Se necesitan dos terminales: una para la API (y el panel) en http://localhost:4000 y otra para el worker.

```bash
npm run api
```

```bash
npm run worker
```

La API **no ejecuta** infraestructura: registra la operación y responde `202`. El worker la toma, copia las plantillas (`INFRA_DIR`) o las clona (`INFRA_REPO@INFRA_REF`), ejecuta el motor y guarda el progreso. Así se cumple el requisito "aprovisionamientos como trabajos en segundo plano".

### API

| Método y ruta | Qué hace |
|---|---|
| `GET /api/planes` | Catálogo de planes (RF-01, RF-03) |
| `GET /api/tenants?nombre=&estado=&plan=&entorno=` | Buscar tenants (RF-14) |
| `GET /api/tenants/:id` | Detalle con su historial de operaciones |
| `POST /api/tenants` | Crear: `{id, nombre, contacto_email, entorno, plan, motor}`. Responde `202` (RF-07, RF-08). |
| `POST /api/tenants/:id/suspender` · `/reanudar` | Ciclo de vida (RF-16) |
| `POST /api/tenants/:id/eliminar` | **Solo previsualiza:** calcula con `plan -destroy` qué se borrará (RF-18) |
| `POST /api/operaciones/:id/confirmar` | Confirma la eliminación: `{confirmacion: "<id del tenant>"}` |
| `POST /api/operaciones/:id/cancelar` | Cancela la eliminación |
| `GET /api/operaciones/:id?desde=N` | Paso actual, error comprensible y log saneado (RF-11) |
| `POST /api/operaciones/:id/reintentar` | Reintenta una operación fallida sobre el mismo estado, sin duplicar recursos (RF-12) |
| `GET /api/monitoreo?tenant=` | Reglas de alerta de Grafana y alertas activas por tenant (RF-29) |

Autenticación: si `PLATAFORMA_ADMIN_KEY` tiene valor, cada llamada debe enviar la cabecera `X-Admin-Key`. La cabecera `X-Usuario` queda registrada como quién pidió la operación.

Cada operación guarda en `versiones` lo que usó: la versión de la app, el origen y commit de las plantillas (y si tenían cambios sin commit), la versión del motor y de los providers, y la AMI de Packer (RF-13).

Para ver las alertas en el panel, `GRAFANA_URL` del `.env` debe apuntar al Grafana de `infra/plataforma`. El token de solo lectura se lee de SSM.

## Documentación

- [Arquitectura y flujo de creación de un tenant](docs/arquitectura.md)
- [Catálogo de planes y límites](docs/planes.md)
- [Monitoreo y alertas](docs/monitoreo.md)

## Alcance de la demo

De 3 a 4 tenants, uno por plan (Básico, Estándar, Avanzado) y repartidos entre los motores. La cuenta tiene una cuota de 16 vCPU On-Demand en us-east-1.

## Reglas

- No se suben secretos ni credenciales: van en SSM Parameter Store o en variables de entorno del servidor.
- No se suben los archivos de estado de IaC: van en S3, uno por tenant.
