# infra

Terraform de la propia plataforma. Se aplica **una vez por cuenta**, antes de crear cualquier tenant.

| Carpeta | Crea | Estado |
|---|---|---|
| `bootstrap/` | Bucket S3 `asistencia-iac-estado-<cuenta>`: versionado, cifrado AES256, sin acceso público, solo TLS | Local (`bootstrap/terraform.tfstate`, fuera de git) |
| `red/` | VPC compartida `10.20.0.0/16`, 2 subredes públicas, IGW y el SG de la plataforma | S3: `plataforma/red.tfstate` |
| `plataforma/` | EC2 de la plataforma (t3.small, IP elástica) con el portal, la API y el worker, y Prometheus, blackbox_exporter y Grafana, instalados por Ansible; rol IAM del worker, permissions boundary de los tenants, claves del portal y de Grafana en SSM | S3: `plataforma/portal.tfstate` |

## Orden

```bash
export AWS_PROFILE=andres
```

```bash
cd infra/bootstrap && terraform init && terraform apply
```

```bash
cd ../red && terraform init && terraform apply
```

`plataforma/` necesita las IPs desde las que se abrirán el portal y Grafana, en un `terraform.tfvars` que no se sube a git:

```bash
cd ../plataforma && echo 'cidrs_admin = ["'$(curl -s https://checkip.amazonaws.com)'/32"]' > terraform.tfvars
```

```bash
terraform init && terraform apply
```

La instancia tarda unos 5 minutos en quedar lista (Ansible instala todo en el primer arranque). Después, `terraform output portal_url` da la URL del portal. Ver [ansible/README.md](../ansible/README.md) y [docs/monitoreo.md](../docs/monitoreo.md).

## Cómo se guarda y protege el estado

Este apartado responde al requisito no funcional "Documentar cómo se almacena y protege el estado del motor".

- **Dónde:** un único bucket S3. La plataforma usa `plataforma/*.tfstate` y cada tenant usa `tenants/<tenant_id>/terraform.tfstate`; así cada tenant tiene su estado aislado.
- **Bloqueo:** `use_lockfile = true` (lock nativo de S3, Terraform ≥ 1.10 y OpenTofu ≥ 1.10). Si dos operaciones corren a la vez sobre el mismo tenant, la segunda espera o falla en vez de corromper el estado.
- **Cifrado:** SSE-S3 en reposo y TLS obligatorio en tránsito (la política del bucket rechaza HTTP).
- **Recuperación:** el versionado permite volver a una versión anterior del estado; las versiones antiguas se borran a los 90 días.
- **Acceso:** el bucket bloquea todo acceso público. Solo lo usan el perfil del administrador y el rol IAM de la EC2 de la plataforma; el worker solo puede leer y escribir `tenants/*`.
- **Contenido sensible:** el estado de un tenant guarda su `AdminKey` (que también está en SSM como SecureString). Por eso el estado se trata como un secreto y nunca se sube a git.

## Permisos del worker

En la EC2, el worker ejecuta Terraform u OpenTofu con el **rol IAM de la instancia** (`asistencia-plataforma-rol`, política `worker-tenants`). No hay claves de AWS en la máquina.

| Qué | Cómo se limita |
|---|---|
| Estado | Solo `s3://asistencia-iac-estado-<cuenta>/tenants/*` |
| Crear EC2, volúmenes y SG | Permitido. Las etiquetas solo se pueden poner al crear, o sobre recursos que ya son `Componente=tenant` |
| Detener, terminar, modificar, borrar volúmenes o SG | Solo recursos con el tag `Componente=tenant`: la EC2 de la plataforma (`Componente=plataforma`) queda fuera |
| Roles IAM de los tenants | Solo `asistencia-*`, y crearlos o cambiar sus políticas **exige** el permissions boundary `asistencia-limite-tenant` |
| `iam:PassRole` | Solo roles `asistencia-*` y solo hacia EC2 |
| La propia plataforma | `Deny` explícito sobre su rol, su perfil y el borrado de sus secretos en SSM; tampoco puede quitar ni cambiar el boundary |

El boundary `asistencia-limite-tenant` es el techo de cualquier rol de tenant: solo el agente de SSM y leer parámetros `/asistencia/*`, con `Deny` sobre `/asistencia/plataforma/*`. Aunque alguien lograra escribir otra política en un rol de tenant, la instancia no podría hacer nada más. Además, cada rol solo lee los parámetros de su propio tenant (política `leer-ssm-propio` del módulo).

Los identificadores `plataforma` y `limite` (y los que empiezan por ellos y un guion) están reservados en la API, porque los recursos de un tenant se llaman `asistencia-<id>-*`.
