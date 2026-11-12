# Catálogo de planes

Entregable 4: "Catálogo de planes y límites de cada uno". La fuente única de verdad es [`catalogo/planes.json`](../catalogo/planes.json):

- La **API** lo usa para mostrar los planes en el wizard (RF-01, RF-03).
- El **worker** lo usa para traducir el plan elegido en variables del motor de IaC (RF-02).

Este documento lo explica; si cambia un valor, se cambia primero en el JSON.

## Resumen

| | **Básico** | **Estándar** | **Avanzado** |
|---|---|---|---|
| Para | Instituciones pequeñas | Instituciones en crecimiento | Alta demanda |
| **Cómputo** (EC2) | t3.micro: 2 vCPU, 1 GiB | t3.small: 2 vCPU, 2 GiB | t3.medium: 2 vCPU, 4 GiB |
| **Disco del sistema** | 8 GB gp3 | 8 GB gp3 | 8 GB gp3 |
| **Volumen de datos** (SQLite, cifrado) | 10 GB gp3 | 20 GB gp3 | 40 GB gp3 |
| Estudiantes | hasta 100 | hasta 1 000 | hasta 5 000 |
| Docentes | hasta 5 | hasta 50 | hasta 200 |
| Cursos | hasta 10 | hasta 100 | hasta 500 |
| Importación Excel | hasta 2 MB | hasta 5 MB | hasta 10 MB |
| Retención mientras está suspendido | 30 días | 90 días | 180 días |
| Respaldo (snapshot EBS)* | semanal, 7 días | diario, 14 días | diario, 30 días |
| Intervalo de métricas | 60 s | 30 s | 15 s |
| **Costo aprox. activo** | ~12.7 USD/mes | ~21.1 USD/mes | ~37.9 USD/mes |
| **Costo aprox. suspendido** | ~1.4 USD/mes | ~2.2 USD/mes | ~3.8 USD/mes |

\* Los respaldos se implementan en la fase final del proyecto, con snapshots del volumen de datos y estos valores. RF-19 aparece tachado en el enunciado, pero el entregable 6 todavía lo menciona.

Todos los planes incluyen frontend y API, una base de datos aislada en su propio volumen EBS cifrado y monitoreo en Grafana.

## Cómo se aplica cada valor

| Campo del JSON | Dónde se usa |
|---|---|
| `infra.instance_type` | Variable `instance_type` del módulo `tenant`; tipo de instancia en Pulumi y CloudFormation |
| `infra.root_volume_gb` | Tamaño del disco raíz de la EC2 |
| `infra.data_volume_gb` | Tamaño del volumen EBS de datos, montado en `/var/lib/asistencia` |
| `limites.*` | Se pasan a la app como variables de entorno (`MAX_ESTUDIANTES`, etc.) a través de cloud-init. Grafana alerta cuando el uso se acerca al límite. |
| `operacion.retencion_suspendido_dias` | La plataforma marca el tenant como "retención vencida" pasado ese plazo; borrarlo sigue siendo manual, con confirmación (RF-18) |
| `monitoreo.intervalo_metricas_s` | Intervalo con que Prometheus lee las métricas de ese tenant |
| `comunes.alertas` | Umbrales de las reglas de alerta en Grafana (RF-28) |

### Por qué los tres planes tienen 2 vCPU

La familia t3 (micro, small, medium) tiene siempre 2 vCPU; lo que cambia es la memoria y el crédito de CPU sostenida. Así la demo cabe sin problema en la cuota de la cuenta (16 vCPU On-Demand): 4 tenants y la plataforma suman 10 vCPU. Además, t3.micro entra en la capa gratuita.

## Límites de uso (RF-05)

RF-05 ("impedir que un tenant exceda los límites") está tachado en el enunciado, así que los límites de la tabla se aplican de esta forma:

1. **Por infraestructura (siempre):** el tenant no puede usar más CPU, memoria ni disco de los que tiene asignados.
2. **Por monitoreo (siempre):** Grafana alerta al llegar al 90 % del límite de estudiantes y al 80 % del volumen de datos.
3. **En la app (opcional):** si se reactiva RF-05, la app rechaza altas que superen `MAX_ESTUDIANTES`, `MAX_DOCENTES` o `MAX_CURSOS`.

## Política de suspensión y retención (RF-16, RF-17)

| Acción | Qué hace con la infraestructura | Qué pasa con los datos |
|---|---|---|
| **Suspender** | Detiene la EC2 (`stopped`). Se libera la IP pública y solo se paga el almacenamiento. | El volumen de datos se conserva intacto |
| **Reanudar** | Arranca la EC2 y espera a que `/api/health` responda 200 | Mismos datos que antes de suspender. La URL puede cambiar porque la IP pública es nueva. |
| **Suspendido más allá de la retención** | Nada automático; la plataforma lo marca como "retención vencida" | Se conservan hasta que el administrador elimine el tenant |
| **Eliminar** | `plan -destroy`: se muestra la lista de recursos y se pide confirmación (RF-18) | El volumen de datos se borra. Si hay respaldos, se conservan según `retencion_respaldos_dias`. |

## Costos estimados

Precios On-Demand de us-east-1, aproximados (730 h/mes):

| Concepto | Básico | Estándar | Avanzado |
|---|---|---|---|
| EC2 | 7.59 (t3.micro) | 15.18 (t3.small) | 30.37 (t3.medium) |
| Disco raíz 8 GB gp3 | 0.64 | 0.64 | 0.64 |
| Volumen de datos gp3 | 0.80 | 1.60 | 3.20 |
| IP pública IPv4 | 3.65 | 3.65 | 3.65 |
| **Total activo** | **12.68** | **21.07** | **37.86** |
| **Total suspendido** (solo discos) | **1.44** | **2.24** | **3.84** |

Para la demo los tenants viven unas pocas horas, así que el costo real es de centavos. Al terminar cada sesión de pruebas se eliminan con la plataforma o con `terraform destroy`.
