# infra

Terraform de la propia plataforma. Se aplica **una vez por cuenta**, antes de crear cualquier tenant.

| Carpeta | Crea | Estado |
|---|---|---|
| `bootstrap/` | Bucket S3 `asistencia-iac-estado-<cuenta>`: versionado, cifrado AES256, sin acceso público, solo TLS | Local (`bootstrap/terraform.tfstate`, fuera de git) |
| `red/` | VPC compartida `10.20.0.0/16`, 2 subredes públicas, IGW y el SG de la plataforma | S3: `plataforma/red.tfstate` |
| `plataforma/` | EC2 de la plataforma (t3.small, IP elástica) con Prometheus, blackbox_exporter y Grafana instalados por Ansible; rol IAM, contraseña de Grafana en SSM. Más adelante, también el portal y el worker. | S3: `plataforma/portal.tfstate` |

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

`plataforma/` necesita las IPs desde las que se abrirá Grafana, en un `terraform.tfvars` que no se sube a git:

```bash
cd ../plataforma && echo 'cidrs_admin = ["'$(curl -s https://checkip.amazonaws.com)'/32"]' > terraform.tfvars
```

```bash
terraform init && terraform apply
```

La instancia tarda unos 5 minutos en quedar lista (Ansible instala todo en el primer arranque). Ver [ansible/README.md](../ansible/README.md) y [docs/monitoreo.md](../docs/monitoreo.md).

## Cómo se guarda y protege el estado

Este apartado responde al requisito no funcional "Documentar cómo se almacena y protege el estado del motor".

- **Dónde:** un único bucket S3. La plataforma usa `plataforma/*.tfstate` y cada tenant usa `tenants/<tenant_id>/terraform.tfstate`; así cada tenant tiene su estado aislado.
- **Bloqueo:** `use_lockfile = true` (lock nativo de S3, Terraform ≥ 1.10 y OpenTofu ≥ 1.10). Si dos operaciones corren a la vez sobre el mismo tenant, la segunda espera o falla en vez de corromper el estado.
- **Cifrado:** SSE-S3 en reposo y TLS obligatorio en tránsito (la política del bucket rechaza HTTP).
- **Recuperación:** el versionado permite volver a una versión anterior del estado; las versiones antiguas se borran a los 90 días.
- **Acceso:** el bucket bloquea todo acceso público. Solo lo usan el perfil del administrador y, más adelante, el rol IAM del worker.
- **Contenido sensible:** el estado de un tenant guarda su `AdminKey` (que también está en SSM como SecureString). Por eso el estado se trata como un secreto y nunca se sube a git.
