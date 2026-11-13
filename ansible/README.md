# ansible

Playbook que configura la EC2 de la plataforma: el **portal, la API y el worker**, y **Prometheus**, **blackbox_exporter** y **Grafana** con su provisioning (datasource, dashboard y reglas de alerta). Detalle del monitoreo en [docs/monitoreo.md](../docs/monitoreo.md).

| Rol | Instala |
|---|---|
| `prometheus` | Prometheus 3.5 (binario oficial, sha256 verificado). Descubre los tenants por tags de EC2, con un trabajo por plan. |
| `blackbox` | blackbox_exporter 0.27 para sondear `/api/health` de cada tenant |
| `grafana` | Grafana OSS desde su repositorio firmado, el dashboard `tenants.json`, las alertas (`alertas.yml.j2`) y la cuenta de servicio de solo lectura para la API de la plataforma |
| `plataforma` | Node.js 22, Terraform y OpenTofu (binarios oficiales con sha256 verificado), el código de este repo en `/opt/plataforma` (de root, solo lectura para el servicio), `npm ci` y dos servicios systemd: `plataforma-api` (puerto 80) y `plataforma-worker`. Corren como el usuario `plataforma`, que solo escribe en `/var/lib/plataforma` (BD, operaciones, caché de providers). También crea 2 GB de swap. |

## Cómo se ejecuta

Ansible no funciona como nodo de control en Windows, así que el playbook **se ejecuta en la propia instancia** (`ansible-playbook -c local`):

1. `terraform apply` en `infra/plataforma` comprime esta carpeta y la sube a `s3://asistencia-iac-estado-<cuenta>/artefactos/ansible/plataforma.zip`. Junto a ella sube `vars.json`, con la región y los umbrales e intervalos del catálogo.
2. En el primer arranque, cloud-init instala `ansible-core` y ejecuta `/usr/local/bin/aplicar-ansible.sh`, que descarga ambos archivos de S3 y aplica `plataforma.yml`.
3. Si después cambia el playbook o el catálogo, el siguiente `terraform apply` sube el paquete nuevo. Como el hash forma parte de la asociación de SSM (`aws_ssm_association`), SSM vuelve a ejecutar el script en la instancia sin recrearla y sin SSH.

El log queda en `/var/log/ansible-plataforma.log` de la instancia. Un `flock` evita que cloud-init y SSM lo ejecuten a la vez.

## Secretos

No hay ninguno en esta carpeta:
- La contraseña de admin de Grafana la crea Terraform (`random_password`) y la guarda en SSM. El rol la lee y la deja en `/etc/grafana/plataforma.env`, con permisos `0600` y solo para root.
- La clave de administrador del portal sigue el mismo camino: Terraform la guarda en `/asistencia/plataforma/admin-key` y el rol `plataforma` la escribe en `/etc/plataforma/plataforma.env` (`0600`, root; systemd la pasa al servicio).
- El token de la cuenta de servicio lo crea el rol una sola vez y lo guarda en SSM como SecureString. Pasa por un archivo temporal, nunca por la línea de comandos, y todas las tareas que lo manejan usan `no_log`.

## Volver a aplicarlo a mano

También sirve para desplegar una versión nueva del portal después de hacer push: el rol vuelve a clonar `plataforma_ref`, ejecuta `npm ci` y reinicia los servicios si algo cambió.

```bash
aws ssm send-command --instance-ids <instance_id> --document-name AWS-RunShellScript --parameters commands=/usr/local/bin/aplicar-ansible.sh
```
