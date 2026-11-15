# Guía de operación

Cómo levantar la plataforma, operar los tenants (entregable 6), diagnosticar problemas y controlar los costos. Los comandos usan el perfil del AWS CLI del administrador (`AWS_PROFILE=andres` en este proyecto) y la región `us-east-1`.

## Accesos

| Qué | Dónde | Credencial |
|---|---|---|
| Portal de la plataforma | `terraform output portal_url` en `infra/plataforma` (hoy http://34.198.238.64) | Clave de administrador, que se pega en *Configuración* |
| Grafana | `terraform output grafana_url` (puerto 3000) | Usuario `admin` |
| App de un tenant | La URL que muestra el panel en el detalle del tenant | Clave del panel docente en `/asistencia/<tenant>/admin-key` |

Obtener las claves (nunca están en el repositorio):

```bash
aws ssm get-parameter --with-decryption --name /asistencia/plataforma/admin-key --query Parameter.Value --output text
```

```bash
aws ssm get-parameter --with-decryption --name /asistencia/plataforma/grafana-admin --query Parameter.Value --output text
```

```bash
aws ssm get-parameter --with-decryption --name /asistencia/<tenant>/admin-key --query Parameter.Value --output text
```

El portal y Grafana **solo se abren desde las IPs de `cidrs_admin`** (ver [Cambiar la IP de administración](#cambiar-la-ip-de-administración)).

## Levantar todo desde cero

En una cuenta nueva, una sola vez y en este orden:

1. **Estado** (`infra/bootstrap`): crea el bucket S3 del estado.

   ```bash
   cd infra/bootstrap && terraform init && terraform apply
   ```

2. **Red** (`infra/red`): crea la VPC compartida, las subredes y el SG de la plataforma.

   ```bash
   cd ../red && terraform init && terraform apply
   ```

3. **AMI de los tenants** (`asistencia-infra/packer`), en unos 6 minutos. Es opcional, pero sin ella los tenants arrancan más lento y sin node_exporter.

   ```bash
   cd asistencia-infra/packer && packer init . && packer build .
   ```

4. **Plataforma** (`infra/plataforma`): necesita tu IP en un `terraform.tfvars` que no se sube a git.

   ```bash
   cd plataforma-tenants/infra/plataforma && echo 'cidrs_admin = ["'$(curl -s https://checkip.amazonaws.com)'/32"]' > terraform.tfvars
   ```

   ```bash
   terraform init && terraform apply
   ```

   En unos 5 minutos Ansible deja instalados Prometheus, Grafana, el portal, la API y el worker. El código del portal se clona desde GitHub (`plataforma_ref`, por defecto `main`), así que antes hay que hacer push.

Si se usa otra cuenta de AWS, hay que cambiar el número de cuenta y el nombre del bucket donde aparecen fijos (`aws_account_id` y los bloques `backend "s3"` de `infra/*` y de `asistencia-infra/terraform`).

## Operar un tenant (entregable 6)

Todo se hace desde el **panel** o con la API (cabecera `X-Admin-Key`). Cada acción crea una operación que el worker ejecuta en segundo plano. El panel muestra el progreso en vivo y, al terminar, el resultado y las versiones usadas.

Para los ejemplos con `curl`:

```bash
K=$(aws ssm get-parameter --with-decryption --name /asistencia/plataforma/admin-key --query Parameter.Value --output text); P=http://34.198.238.64
```

### Crear

Panel: **+ Crear tenant**. Son tres pasos: datos de la institución (nombre, identificador, correo, entorno), plan y motor (Terraform, OpenTofu o CloudFormation), y revisión. Los tenants de CloudFormation se ven como un stack `asistencia-<id>` en la consola de CloudFormation y no permiten restaurar.

```bash
curl -X POST $P/api/tenants -H "X-Admin-Key: $K" -H "Content-Type: application/json" -d '{"id":"colegio-x","nombre":"Colegio X","contacto_email":"admin@colegio-x.edu","entorno":"dev","plan":"basico","motor":"terraform"}'
```

Tarda unos 2 minutos con la AMI de Packer. Cuando la app responde, el tenant pasa a **activo** y aparece en Grafana en menos de un minuto. El nombre de la institución se muestra como título de su app.

### Suspender y reanudar

Panel: **Suspender**. Detiene la EC2, conserva el volumen de datos y solo se pagan los discos. Grafana deja de medirlo y no genera alertas. **Reanudar** arranca la EC2 y espera a que la app responda. Los datos son los mismos, pero la **IP pública cambia**.

```bash
curl -X POST $P/api/tenants/colegio-x/suspender -H "X-Admin-Key: $K"
```

```bash
curl -X POST $P/api/tenants/colegio-x/reanudar -H "X-Admin-Key: $K"
```

Si un tenant pasa suspendido más días que la retención de su plan (30, 90 o 180), el panel lo marca como **retención vencida**. Sus datos no se borran solos: eliminarlo es una decisión del administrador.

### Respaldar

Panel: **Respaldar ahora**, o esperar a los respaldos programados (Básico, los domingos; Estándar y Avanzado, a diario; siempre a las 02:00 hora de Bolivia). La tarjeta **Respaldos** del detalle lista todos con su origen y su vencimiento.

```bash
curl -X POST $P/api/tenants/colegio-x/respaldar -H "X-Admin-Key: $K"
```

### Restaurar

Panel: en **Respaldos**, **Restaurar…** en el snapshot elegido, y confirmar escribiendo el identificador del tenant. El tenant debe estar activo. Primero se crea un respaldo de los datos actuales; después se reemplaza el volumen y se recrea la instancia, así que la IP cambia. Lo registrado después de la fecha del snapshot se pierde; para deshacer, se restaura el respaldo "antes de restaurar".

```bash
curl -X POST $P/api/tenants/colegio-x/restaurar -H "X-Admin-Key: $K" -H "Content-Type: application/json" -d '{"snapshot_id":"snap-…","confirmacion":"colegio-x"}'
```

Detalle en [respaldos.md](respaldos.md).

### Eliminar

Panel: **Eliminar…**. Primero se calcula con `plan -destroy` qué se borrará: la lista de recursos, con los datos marcados. Después se confirma escribiendo el identificador. Los respaldos se conservan hasta su vencimiento.

```bash
curl -X POST $P/api/tenants/colegio-x/eliminar -H "X-Admin-Key: $K"
```

```bash
curl -X POST $P/api/operaciones/<id de la previsualización>/confirmar -H "X-Admin-Key: $K" -H "Content-Type: application/json" -d '{"confirmacion":"colegio-x"}'
```

### Reintentar una operación fallida

Panel: el detalle del tenant muestra **Reintentar** cuando la última operación falló. Se vuelve a aplicar sobre el mismo estado y solo se crea lo que falta. El error se lee en el detalle de la operación, en lenguaje comprensible, junto con el log completo.

### Actualizar un tenant

No hay un botón propio, porque RF-15 está tachado en el enunciado. Así llegan los cambios a un tenant existente:

- **Infraestructura o catálogo** (plantillas de `asistencia-infra` o `planes.json`): cada operación clona las plantillas vigentes y lee el catálogo, así que el cambio se aplica en la siguiente operación del tenant (suspender y reanudar, o reintentar). Si cambió la plantilla de arranque, la instancia se recrea; los datos están en el volumen y no se pierden.
- **Versión de la app**: la app se instala al crear la instancia. Para actualizarla sin recrearla:

  ```bash
  aws ssm send-command --instance-ids <instancia del tenant> --document-name AWS-RunShellScript --parameters 'commands=["cd /opt/asistencia && git fetch --depth 1 origin main && git reset --hard FETCH_HEAD && cd backend && npm ci --omit=dev && systemctl restart asistencia"]'
  ```

## Actualizar la plataforma

| Qué cambió | Cómo se aplica |
|---|---|
| Código del portal, API o worker | Push a `main` y volver a aplicar Ansible (abajo). Clona, ejecuta `npm ci` y reinicia los servicios |
| Playbook, dashboard, alertas o catálogo | `terraform apply` en `infra/plataforma`: sube el paquete nuevo y SSM vuelve a aplicar Ansible solo |
| Infraestructura de la plataforma (IAM, SG, respaldos) | `terraform apply` en `infra/plataforma` |
| Plantillas de los tenants | Push a `asistencia-infra`; el worker las clona en cada operación |

```bash
aws ssm send-command --instance-ids $(terraform -chdir=infra/plataforma output -raw instance_id) --document-name AWS-RunShellScript --parameters commands=/usr/local/bin/aplicar-ansible.sh
```

Si se reinicia el worker durante una operación, esa operación queda como *interrumpida*; se reintenta sin duplicar recursos.

## Cambiar la IP de administración

Si el portal o Grafana no cargan desde una red nueva, probablemente tu IP no está en la lista:

```bash
curl -s https://checkip.amazonaws.com
```

Agrega `"<ip>/32"` a `cidrs_admin` en `infra/plataforma/terraform.tfvars` y aplica. Solo se agregan reglas al SG; nada se recrea:

```bash
terraform -chdir=infra/plataforma apply
```

## Monitoreo y alerta de ejemplo

- **Dashboard:** Grafana → *Asistencia* → *Tenants del Sistema de Asistencia*. Tiene filtros por entorno, plan y tenant.
- **Alertas:** las 7 reglas se ven en Grafana (*Alerting*) y en la vista **Monitoreo** del panel.
- **Provocar una alerta** (para la demo): detener la app de un tenant. *Servicio caído* pasa a "en observación" en menos de un minuto y a "disparada" a los 2 minutos. Al volver a arrancarla, se resuelve en unos 30 s.

  ```bash
  aws ssm send-command --instance-ids <instancia del tenant> --document-name AWS-RunShellScript --parameters commands="systemctl stop asistencia"
  ```

  ```bash
  aws ssm send-command --instance-ids <instancia del tenant> --document-name AWS-RunShellScript --parameters commands="systemctl start asistencia"
  ```

## Problemas frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| El portal o Grafana no cargan | Tu IP no está en `cidrs_admin` | [Cambiar la IP de administración](#cambiar-la-ip-de-administración) |
| El panel dice "Clave de administrador inválida" | Falta la clave o es incorrecta | Pegarla en *Configuración* |
| "La cuenta AWS está en el plan gratuito y no permite el tipo de instancia…" | Tipo de instancia no elegible en una cuenta del plan gratuito | Usar un tipo elegible en el catálogo (`describe-instance-types --filters Name=free-tier-eligible,Values=true`) y reintentar |
| "El worker no tiene permisos IAM…" | Falta una acción en la política `worker-tenants` | Agregarla en `infra/plataforma/main.tf`, aplicar y reintentar |
| "Otra operación está usando el estado de este tenant" | Lock de S3 tomado | Esperar a que termine; si un proceso murió, reintentar |
| "La infraestructura se creó, pero la app no respondió a tiempo" | Error en el arranque de la app | Ver `/var/log/cloud-init-output.log` y `journalctl -u asistencia` en el tenant (Session Manager) y reintentar |
| Una operación queda *interrumpida* | Se reinició el worker | Reintentar |
| Un cambio del portal no aparece | Ansible no se volvió a aplicar, o no se hizo push | [Actualizar la plataforma](#actualizar-la-plataforma) |

**Logs de la plataforma** (con Session Manager, `aws ssm start-session --target <instance_id>`):

- Ansible: `/var/log/ansible-plataforma.log`
- API y worker: `journalctl -u plataforma-api` y `journalctl -u plataforma-worker`
- Grafana y Prometheus: `journalctl -u grafana-server` y `journalctl -u prometheus`

## Costos y apagado

Precios On-Demand aproximados de us-east-1:

| Recurso | Encendido | Detenido |
|---|---|---|
| Plataforma (t3.small, 20 GB, IP elástica) | ~20.4 USD/mes | ~5.3 USD/mes (disco + IP elástica) |
| Tenant Básico / Estándar / Avanzado | ~12.7 / 21.1 / 69.4 USD/mes | ~1.4 / 2.2 / 3.8 USD/mes |
| Respaldos | ~0.05 USD por GB-mes (incrementales) | — |

**Para una pausa larga:**

1. Suspender o eliminar los tenants desde el panel.
2. Detener la plataforma. La IP elástica se conserva, así que las URLs no cambian:

   ```bash
   aws ec2 stop-instances --instance-ids $(terraform -chdir=infra/plataforma output -raw instance_id)
   ```

   Para volver, `start-instances` con el mismo id; los servicios arrancan solos.

**Para borrar todo:**

1. Eliminar todos los tenants desde el panel; no hay que hacerlo con `terraform destroy`, para que el estado de cada uno quede limpio.
2. Destruir la plataforma y luego la red:

   ```bash
   terraform -chdir=infra/plataforma destroy
   ```

   ```bash
   terraform -chdir=infra/red destroy
   ```

3. Borrar las AMIs de Packer con sus snapshots y los snapshots de respaldo que queden.
4. El bucket del estado (`infra/bootstrap`) va al final, y solo si no se volverá a usar.

## Guion de la demostración

Unos 15 minutos, con la plataforma encendida:

1. **Arquitectura:** el diagrama de [arquitectura.md](arquitectura.md) y la función de cada herramienta.
2. **Planes:** la vista *Planes* (el catálogo sale de `planes.json`).
3. **Crear** tenants con planes y motores distintos (Terraform, OpenTofu y CloudFormation), y seguir el progreso en vivo. Mostrar el stack en la consola de CloudFormation.
4. **App del tenant:** abrir su URL. Muestra el nombre de la institución y los datos de ejemplo.
5. **Grafana:** el dashboard filtrado por tenant y entorno. Provocar *Servicio caído* y verlo en Grafana y en la vista *Monitoreo* del panel.
6. **Suspender y reanudar:** los datos se conservan.
7. **Respaldar, cambiar datos y restaurar:** los datos vuelven al estado del respaldo.
8. **Aislamiento:** ejecutar [evidencias/prueba-aislamiento.sh](evidencias/prueba-aislamiento.sh) en un tenant. Lee su secreto y se le deniega el de otro tenant y los de la plataforma.
9. **Auditoría:** el historial con quién, cuándo, el resultado y las versiones de cada operación.
10. **Eliminar** un tenant: la lista de recursos y la confirmación.
