# Arquitectura: plataforma de tenants de Asistencia

Borrador del entregable 3 ("Diagrama de arquitectura y flujo de creación de un tenant").
Los diagramas están en Mermaid y GitHub los muestra directamente.

## 1. Vista general

Hay dos planos:

- **Plano de control (la plataforma):** una sola instancia. Aloja el panel de administración, la API, el worker que ejecuta los motores de IaC, la base de datos de la plataforma, Prometheus y Grafana.
- **Plano de datos (los tenants):** cada institución tiene su propia EC2 (frontend + backend), su propio volumen de datos y su propio Security Group. Ningún tenant comparte cómputo ni base de datos con otro.

```mermaid
flowchart LR
    admin([Admin plataforma])
    tadmin([Admin tenant / docente / estudiante])

    subgraph AWS["AWS us-east-1"]
        subgraph CP["Plano de control (EC2 plataforma)"]
            ui[Panel web<br/>Tenants, Planes, Monitoreo]
            api[API plataforma<br/>Node + Express]
            db[(BD plataforma<br/>tenants, planes,<br/>operaciones)]
            worker[Worker de jobs<br/>terraform / tofu /<br/>pulumi / cloudformation]
            prom[Prometheus]
            graf[Grafana<br/>paneles + alertas]
        end

        subgraph SH["Servicios compartidos"]
            s3[(S3: estado IaC<br/>+ lock)]
            ssm[(SSM Parameter Store<br/>secretos por tenant)]
            ami[AMI base<br/>creada con Packer]
        end

        subgraph TA["Tenant A (plan Básico)"]
            ea[EC2 app<br/>front + back]
            va[(EBS datos<br/>SQLite)]
        end
        subgraph TB["Tenant B (plan Estándar)"]
            eb[EC2 app<br/>front + back]
            vb[(EBS datos<br/>SQLite)]
        end
    end

    admin --> ui --> api
    api --> db
    api -- encola job --> worker
    worker --> s3
    worker --> ssm
    worker -- crea / suspende / elimina --> TA
    worker -- crea / suspende / elimina --> TB
    worker -- Ansible --> ea
    ami -. arranca desde .-> ea
    ami -. arranca desde .-> eb
    ea --- va
    eb --- vb
    prom -- scrape /metrics --> ea
    prom -- scrape /metrics --> eb
    graf --> prom
    api -- lee alertas --> graf
    tadmin --> ea
    tadmin --> eb
```

## 2. Flujo de creación de un tenant

```mermaid
sequenceDiagram
    actor A as Admin plataforma
    participant UI as Panel web
    participant API as API plataforma
    participant DB as BD plataforma
    participant W as Worker
    participant AWS as AWS (S3, SSM, EC2)
    participant VM as EC2 del tenant
    participant P as Prometheus/Grafana

    A->>UI: Wizard: datos + plan + entorno + motor IaC
    UI->>API: POST /tenants
    API->>DB: tenant (estado=aprovisionando) + operación (pendiente)
    API-->>UI: 202 Accepted + id de operación
    loop cada pocos segundos (RF-11)
        UI->>API: GET /operaciones/:id
        API-->>UI: paso actual + log sin secretos
    end
    W->>DB: toma el job (estado=en_curso)
    W->>AWS: genera AdminKey y la guarda en SSM
    W->>AWS: init + workspace tenant-id + apply (variables del plan)
    AWS->>VM: SG + EBS + EC2 desde la AMI de Packer
    VM->>VM: cloud-init: monta EBS, lee SSM, escribe .env, arranca servicio
    W->>VM: Ansible: configuración posterior (agentes, versión de la app)
    W->>VM: GET /api/health hasta responder 200
    W->>DB: outputs (URL, instance id) + versiones app/plantilla/motor (RF-13)
    W->>DB: tenant=activo, operación=exitosa (o fallida + error legible)
    P->>VM: descubre la instancia por tags y empieza a medir
```

Si el apply falla, la operación queda `fallida` con el error. Reintentar (RF-12) vuelve a correr `apply` sobre **el mismo workspace o stack**. El motor compara el estado guardado con lo que existe en AWS y solo crea lo que falta, así que no duplica recursos.

## 3. Ciclo de vida del tenant

```mermaid
stateDiagram-v2
    [*] --> aprovisionando: crear
    aprovisionando --> activo: apply OK + health OK
    aprovisionando --> fallido: error
    fallido --> aprovisionando: reintentar
    activo --> suspendiendo: suspender
    suspendiendo --> suspendido: EC2 detenida, EBS conservado
    suspendido --> reanudando: reanudar
    reanudando --> activo: EC2 arrancada + health OK
    activo --> eliminando: eliminar (tras plan -destroy y confirmación)
    suspendido --> eliminando: eliminar
    eliminando --> eliminado: destroy OK
    eliminado --> [*]
```

## 4. Función de cada herramienta

| Herramienta | Qué hace en esta arquitectura |
|---|---|
| **Terraform / OpenTofu** | Motor principal. Un mismo módulo `tenant` (SG, EBS, EC2) con un workspace por tenant y el estado en S3. OpenTofu usa el mismo HCL; solo cambia el binario que llama el worker (RF-08). También crea el plano de control. |
| **Pulumi** | Segunda implementación reducida del stack de un tenant (un stack de Pulumi por tenant), para comparar con Terraform. |
| **CloudFormation** | Segunda implementación reducida: un stack por tenant (`asistencia-<tenant>`), a partir de las plantillas que ya existen. |
| **Packer** | Construye la AMI base: Amazon Linux 2023, Node, la app en una versión fija, node_exporter y la unidad systemd. Así el arranque es rápido y repetible. |
| **cloud-init** | Configuración del primer arranque de cada tenant: monta el volumen de datos, lee los secretos del tenant desde SSM, escribe `.env` y arranca el servicio. |
| **Ansible** | Configuración posterior: aplica cambios a VMs que ya existen (versión de la app, agentes, ajustes del plan) sin recrearlas. |
| **Prometheus + Grafana** | Prometheus descubre las EC2 por tags (`Tenant`, `Entorno`, `Plan`) y mide CPU, memoria, disponibilidad y métricas de la app. Grafana muestra los paneles por tenant y entorno y dispara las alertas; la plataforma las consulta por la API de Grafana (RF-29). |

## 5. Decisiones y requisitos no funcionales

- **Aislamiento:** cada tenant tiene su propia EC2, su propio volumen de datos y su propio Security Group. El SG solo permite HTTP desde internet y los puertos de métricas desde el SG de la plataforma; no hay tráfico entre tenants.
- **Red compartida:** todos los tenants usan una sola VPC con subred pública, en vez de una VPC por tenant. AWS limita a 5 VPC por región por defecto, y el aislamiento se logra con los Security Groups.
- **Secretos:** se guardan en SSM Parameter Store (SecureString) bajo `/asistencia/<tenant>/...`. No van en tfvars, en el repo ni en los logs; el worker filtra los valores sensibles antes de guardar la salida del motor.
- **Estado del motor:** se guarda en un bucket S3 con cifrado y versionado, bloqueo de acceso público y lock nativo de S3. Cada tenant usa la clave `tenants/<id>/terraform.tfstate`, y el acceso está restringido al rol IAM del worker.
- **Trabajos en segundo plano:** la API solo encola trabajos. El worker los ejecuta de uno en uno por tenant y guarda el historial de cada operación (quién, cuándo, resultado y log).
- **Suspensión:** se detiene la EC2 y se conserva el EBS de datos; solo se paga el disco. Los datos se mantienen según la política de retención del plan.
- **Costos:** la plataforma puede destruir todos los tenants de prueba con una operación; para la demo se usan t3.micro.

- **Base de datos (decidido):** SQLite en un volumen EBS dedicado a cada tenant, cifrado y montado en `/var/lib/asistencia`. La app no cambia (RF-21) y el plan define el tamaño del volumen.
- **Alcance de la demo (decidido):** de 3 a 4 tenants. La cuota de la cuenta es de 16 vCPU On-Demand: con instancias t3.micro/small (2 vCPU cada una), 4 tenants y la plataforma suman 10 vCPU.

Detalle de cómo se protege el estado: [infra/README.md](../infra/README.md).

## 6. Fase final

- Respaldar y restaurar (RF-19, entregable 6) con snapshots del volumen de datos de cada tenant, según la política de cada plan en [planes.md](planes.md).
