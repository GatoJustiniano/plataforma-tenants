# Aislamiento entre tenants: evidencias (entregable 7)

Cada tenant tiene su propia EC2, su propio volumen de datos, su propio Security Group, su propio rol IAM, sus propios secretos en SSM y su propio estado de IaC. Este documento muestra **pruebas ejecutadas sobre el entorno real**, no solo la configuración.

Pruebas del 13 y 14 de noviembre de 2026, con seis tenants activos:

| Tenant | Plan | Motor | Tipo |
|---|---|---|---|
| `el-pepe` | Básico | Terraform | t3.micro |
| `colegio-prueba` | Básico | Terraform | t3.micro |
| `colegio-tofu` | Básico | **OpenTofu** | t3.micro |
| `el-pomacusi` | Estándar | Terraform | t3.small |
| `la-salle` | Avanzado | Terraform | c7i-flex.large |
| `prueba` | Avanzado | Terraform | c7i-flex.large |

## Resumen

| Capa | Qué se comprobó | Resultado |
|---|---|---|
| Secretos | Un tenant lee su clave de SSM, pero no la de otro tenant ni las de la plataforma | ✅ (tras corregir un hallazgo, ver abajo) |
| Permisos AWS | Un tenant no puede listar EC2, leer estados de S3 ni consultar IAM | ✅ |
| Red | Desde otro tenant y desde internet, los puertos de métricas y SSH están cerrados; solo responde la app (80) | ✅ |
| Plataforma | Prometheus, Grafana y SSH de la plataforma no son accesibles desde los tenants; portal y Grafana solo desde las IPs de administración | ✅ |
| Datos | Cada tenant tiene su base SQLite en su propio volumen EBS cifrado | ✅ |
| Estado de IaC | Un archivo de estado por tenant en S3, cifrado, versionado y sin acceso público | ✅ |
| Worker | Solo puede modificar recursos de tenants; no puede tocar la plataforma ni crear roles sin límite de permisos | ✅ (simulador de políticas IAM) |

## 1. Secretos y permisos desde dentro de un tenant

Se ejecutó [evidencias/prueba-aislamiento.sh](evidencias/prueba-aislamiento.sh) dentro de la EC2 de `el-pepe` y de `colegio-tofu`, con Session Manager. El script usa las credenciales del rol de la propia instancia y **nunca imprime el valor de un secreto**.

Resultado en `colegio-tofu` (creado con OpenTofu):

```
== Secretos (rol asistencia-colegio-tofu-rol)
PERMITIDO /asistencia/colegio-tofu/admin-key (valor de 20 caracteres, no se muestra)
DENEGADO  /asistencia/el-pepe/admin-key -> AccessDeniedException
DENEGADO  /asistencia/la-salle/admin-key -> AccessDeniedException
DENEGADO  /asistencia/plataforma/admin-key -> AccessDeniedException
DENEGADO  /asistencia/plataforma/grafana-admin -> AccessDeniedException
== Otras APIs de AWS
DENEGADO  ec2:DescribeInstances
DENEGADO  leer estados en S3
DENEGADO  iam:ListRoles
```

En `el-pepe` el resultado es el mismo: lee su clave, y se le deniega la de `la-salle` y las de la plataforma.

### Hallazgo corregido: un tenant podía leer el secreto de otro

En la primera ejecución, `el-pepe` **sí pudo leer** `/asistencia/la-salle/admin-key`, aunque la política de su rol (`leer-ssm-propio`) solo permite `/asistencia/el-pepe/*`.

- **Causa:** el rol de cada tenant también tiene la política administrada de AWS `AmazonSSMManagedInstanceCore`, necesaria para Session Manager. Esa política concede `ssm:GetParameter` y `ssm:GetParameters` sobre `"*"`. En IAM los permisos se suman, y el permissions boundary `asistencia-limite-tenant` permitía todo `/asistencia/*` salvo la plataforma, así que no lo frenaba.
- **Corrección:** el boundary ahora solo permite leer `parameter/asistencia/${aws:PrincipalTag/Tenant}/*`. El tag `Tenant` lo pone el motor en el rol de cada tenant. Como todos los roles comparten el boundary, la corrección se aplicó a los tenants existentes sin recrear nada (`infra/plataforma/main.tf`, recurso `aws_iam_policy.limite_tenant`).
- **Verificación:** se repitió la prueba en dos tenants (la salida de arriba) y los seis tenants siguieron respondiendo 200 en `/api/health`. Session Manager siguió funcionando: las propias pruebas se ejecutaron con él.

Este hallazgo muestra por qué el boundary es útil: corrige de una vez una política administrada demasiado amplia, que no controlamos.

## 2. Red

**Desde otro tenant** (`el-pepe` hacia `la-salle` y hacia la plataforma, por IP privada dentro de la VPC):

```
ABIERTO  10.20.1.187:80      app de la-salle (es pública de todos modos)
CERRADO  10.20.1.187:9100    node_exporter
CERRADO  10.20.1.187:9101    métricas de la app
CERRADO  10.20.1.187:22      SSH
CERRADO  10.20.2.93:3000     Grafana de la plataforma
CERRADO  10.20.2.93:9090     Prometheus de la plataforma
CERRADO  10.20.2.93:22       SSH de la plataforma
```

**Desde internet:**

```
ABIERTO 3.83.161.166:80       app de el-pepe
CERRADO 3.83.161.166:9100
CERRADO 3.83.161.166:9101
CERRADO 3.83.161.166:22
CERRADO 34.198.238.64:9090    Prometheus (solo escucha en localhost)
CERRADO 34.198.238.64:9115    blackbox_exporter (solo localhost)
CERRADO 34.198.238.64:22
```

**Reglas que lo explican** (`describe-security-group-rules`):

| SG | Puerto | Origen |
|---|---|---|
| `asistencia-el-pepe-sg` (cada tenant tiene el suyo) | 80 | `0.0.0.0/0` (la app) |
| | 9100, 9101, 22 | solo el SG de la plataforma |
| SG de la plataforma | 80 (portal), 3000 (Grafana) | solo las IPs de `cidrs_admin` |

Ningún SG de tenant referencia al de otro tenant: el único origen privado permitido es la plataforma, que es quien recoge las métricas.

## 3. Datos

Cada tenant monta su propio volumen EBS cifrado en `/var/lib/asistencia`, donde vive su base SQLite (`/dev/nvme1n1 /var/lib/asistencia xfs`).

| Tenant | Volumen de datos | GB | Cifrado | Conectado a |
|---|---|---|---|---|
| colegio-prueba | vol-0bec470b690b7d8be | 10 | sí | i-0b04b25f28dce8db8 |
| colegio-tofu | vol-0d134cf90382b5222 | 10 | sí | i-047f538cbed3f443b |
| el-pepe | vol-0f6eecfed8c210b70 | 10 | sí | i-0eda8273b7dedca20 |
| el-pomacusi | vol-0a882a383e677f0c4 | 20 | sí | i-05082a32b4bbb7271 |
| la-salle | vol-08e5fe2f345c4f42b | 40 | sí | i-047f4365a2a55f31c |
| prueba | vol-03fb099143bed5a8d | 40 | sí | i-0c0ce715fe2052b25 |

El tamaño corresponde al plan de cada uno (Básico 10, Estándar 20, Avanzado 40 GB). Ningún volumen está conectado a dos instancias.

## 4. Estado de IaC

Un archivo por tenant en `s3://asistencia-iac-estado-<cuenta>/tenants/<id>/terraform.tfstate`. El estado de `colegio-tofu` lo escribió OpenTofu en el mismo bucket y con el mismo formato.

- Cifrado `AES256`, versionado `Enabled` y bloqueo total de acceso público (las 4 opciones en `True`).
- Lock nativo de S3 (`use_lockfile`): dos operaciones no pueden modificar el mismo tenant a la vez.
- Los tenants no pueden leer el bucket (prueba 1: `DENEGADO leer estados en S3`). El worker solo puede escribir en `tenants/*` (prueba 5).

## 5. Límites del worker

En la EC2 de la plataforma, el worker crea y elimina tenants con el rol `asistencia-plataforma-rol`. Para comprobar sus límites **sin ejecutar acciones destructivas** se usó el simulador de políticas de IAM (`aws iam simulate-principal-policy`) con el contexto de cada caso:

| Acción | Resultado |
|---|---|
| Terminar la EC2 de un tenant (`Componente=tenant`) | allowed |
| Terminar la EC2 de la plataforma (`Componente=plataforma`) | implicitDeny |
| Borrar un volumen que no es de un tenant | implicitDeny |
| Crear un rol `asistencia-*` **con** el boundary | allowed |
| Crear un rol `asistencia-*` **sin** el boundary | implicitDeny |
| Crear un rol fuera de `asistencia-*` | implicitDeny |
| Escribir una política en el rol de la plataforma | explicitDeny |
| Quitar el boundary a un rol de tenant | explicitDeny |
| Modificar el boundary (nueva versión) | explicitDeny |
| Pasar un rol de tenant a EC2 | allowed |
| Pasar un rol de tenant a Lambda | implicitDeny |
| Escribir el estado de un tenant | allowed |
| Escribir el estado de la plataforma | implicitDeny |
| Borrar la clave de administrador de la plataforma | explicitDeny |
| Crear un usuario IAM | implicitDeny |
| Crear un bucket | implicitDeny |

Además, la API rechaza los identificadores `plataforma` y `limite`, porque un tenant con ese nombre crearía recursos `asistencia-plataforma-*`.

Ya en la práctica, cuando al worker le faltó un permiso (`ssm:ListTagsForResource`), AWS lo bloqueó y el panel mostró "El worker no tiene permisos IAM para una de las acciones de la plantilla". El reintento, después de corregir la política, completó el tenant sin duplicar recursos (RF-12).

## Cómo repetir las pruebas

1. **Dentro de un tenant:** el comando de la cabecera de [evidencias/prueba-aislamiento.sh](evidencias/prueba-aislamiento.sh), con las variables `OTROS`, `OTRO_IP` y `PLATAFORMA_IP` del momento.
2. **Desde internet:**

   ```bash
   timeout 5 bash -c "</dev/tcp/<ip_tenant>/9100" && echo ABIERTO || echo CERRADO
   ```

3. **Worker:**

   ```bash
   aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::<cuenta>:role/asistencia-plataforma-rol --action-names ec2:TerminateInstances --resource-arns <arn> --context-entries ContextKeyName=aws:ResourceTag/Componente,ContextKeyValues=plataforma,ContextKeyType=string
   ```
