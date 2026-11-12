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
frontend/   Panel de administración: Tenants, Planes, Monitoreo, Auditoría
api/        API REST: tenants, planes, operaciones; encola los trabajos
worker/     Ejecuta las operaciones: clona asistencia-infra@tag y corre el motor elegido
infra/      Terraform de la propia plataforma: VPC compartida, EC2 del portal, bucket S3 del estado, roles IAM
grafana/    Provisioning de Prometheus y Grafana: datasources, paneles y alertas como código
docs/       Arquitectura, catálogo de planes, instrucciones de operación y evidencias
```

## Documentación

- [Arquitectura y flujo de creación de un tenant](docs/arquitectura.md)

## Alcance de la demo

De 3 a 4 tenants, uno por plan (Básico, Estándar, Avanzado) y repartidos entre los motores. La cuenta tiene una cuota de 16 vCPU On-Demand en us-east-1.

## Reglas

- No se suben secretos ni credenciales: van en SSM Parameter Store o en variables de entorno del servidor.
- No se suben los archivos de estado de IaC: van en S3, uno por tenant.
