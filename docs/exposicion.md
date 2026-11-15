# Guía para la exposición: cada herramienta en el código

Una sección por herramienta, en el orden en que "nace" un tenant. Cada sección tiene la idea central, qué mostrar del código (con enlace a la línea), una demostración corta y las preguntas probables.

**Hilo de toda la exposición:** *"Cuando el administrador crea un tenant en el panel, ¿qué hace cada herramienta para que esa institución tenga su app funcionando, aislada y monitoreada?"*

| # | Herramienta | Expone | Tiempo |
|---|---|---|---|
| 1 | Terraform | *(sin asignar)* | 4 min |
| 2 | OpenTofu | Alavro | 3 min |
| 3 | CloudFormation | Wilfredo | 4 min |
| 4 | Pulumi | Deyvi | 3 min |
| 5 | Packer | Santo | 3 min |
| 6 | cloud-init | *(sin asignar)* | 4 min |
| 7 | Ansible | Pablo | 4 min |
| 8 | Grafana (y Prometheus) | Diego | 4 min |

Antes de exponer: abrir el portal (http://34.198.238.64) y Grafana (http://34.198.238.64:3000) con las claves de SSM ([operacion.md](operacion.md#accesos)), y tener **un tenant activo** creado con antelación (tarda unos 2 minutos). Los enlaces apuntan a la rama `main`; si alguien cambia el código, los números de línea pueden moverse.

Repositorios: [plataforma-tenants](https://github.com/GatoJustiniano/plataforma-tenants) · [asistencia-infra](https://github.com/GatoJustiniano/asistencia-infra) · [asistencia-app](https://github.com/GatoJustiniano/asistencia-app)

---

## 1. Terraform: el motor principal

**En una frase:** describe en HCL *qué* recursos debe tener un tenant; Terraform compara eso con lo que existe en AWS (el *estado*) y crea, cambia o borra solo la diferencia.

**Qué hace aquí:** crea todo lo de un tenant (SG, secreto, rol IAM, volumen, EC2) y también la propia plataforma (bucket del estado, red, EC2 de la plataforma, IAM y respaldos).

**Recorrido por el código:**

1. **Estado remoto, uno por tenant:** [versions.tf L18-L23](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/versions.tf#L18-L23). El bucket S3 guarda el estado y `use_lockfile = true` impide que dos operaciones modifiquen el mismo tenant a la vez. La clave del archivo no está fija: el worker la pasa en el `init` → [terraform.js L27-L29](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/motores/terraform.js#L27-L29) (`tenants/<id>/terraform.tfstate`).
2. **Tags por defecto:** [main.tf L4](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/main.tf#L4). Todo recurso nace con `Tenant`, `Plan`, `Entorno` y `Componente=tenant`. De esto dependen el monitoreo, los respaldos y los permisos.
3. **El módulo `tenant`:** [main.tf L41](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/main.tf#L41) → [modules/tenant/main.tf](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf). Recorrerlo en orden:
   - SG propio: [L39](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf#L39) (80 público; métricas solo desde la plataforma).
   - Secreto: `random_password` + SSM SecureString, [L77-L82](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf#L77-L82). La clave nunca se escribe en el código.
   - Rol IAM con *permissions boundary*: [L91-L94](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf#L91-L94).
   - Volumen de datos (SQLite): [L131](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf#L131).
   - EC2: [L154](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf#L154). Usa la AMI de Packer y le pasa cloud-init con `templatefile` ([L172](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf#L172)).
   - `stop_instance_before_detaching` ([L208](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf#L208)): detiene la EC2 antes de desconectar el disco, para no corromper SQLite.
   - Suspender sin destruir nada: `aws_ec2_instance_state` ([L212](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf#L212)).
4. **Cómo lo ejecuta la plataforma:** [worker.js L128](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/worker.js#L128). Crear, suspender, reanudar y restaurar son el mismo `apply` con distintas variables. Eliminar primero hace `plan -destroy` y lo convierte a JSON para mostrarlo ([terraform.js L43-L45](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/motores/terraform.js#L43-L45)).

**Demostración:** crear un tenant en el panel y mostrar el log en vivo (`init`, `Plan: 16 to add`, `Apply complete`). En el detalle de la operación están las versiones registradas: commit de las plantillas, Terraform y provider (RF-13).

**Preguntas probables:**
- *¿Qué pasa si falla a la mitad?* La operación queda fallida; **Reintentar** vuelve a ejecutar `apply` sobre el mismo estado y solo crea lo que falta. Lo probamos con dos fallos reales.
- *¿Dónde está el estado y cómo se protege?* En S3: cifrado, versionado, sin acceso público y con lock ([infra/README.md](../infra/README.md#cómo-se-guarda-y-protege-el-estado)).
- *¿Por qué un estado por tenant?* Para aislar: un error o un bloqueo en un tenant no afecta a los demás.

**Pasa a:** "El mismo HCL se puede ejecutar con otro binario…" → OpenTofu.

---

## 2. OpenTofu: el mismo código, otro motor

**En una frase:** OpenTofu es el *fork* libre de Terraform (Linux Foundation); lee el mismo HCL y el mismo formato de estado.

**Qué hace aquí:** es el segundo motor que se puede elegir al crear un tenant (RF-08). No tiene plantillas propias: usa exactamente las de Terraform.

**Recorrido por el código:**

1. **El único cambio es el binario:** [terraform.js L8](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/motores/terraform.js#L8). `tofu` o `terraform`; el resto del motor (init, apply, plan -destroy) es idéntico.
2. **Registro del motor en el worker:** [worker.js L21-L24](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/worker.js#L21-L24).
3. **El tag `Herramienta`** cambia según el motor: [catalogo.js L23](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/comun/catalogo.js#L23) → [main.tf L11](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/main.tf#L11). Así se distingue en AWS qué motor creó cada recurso.
4. **Compatibilidad del estado:** [versions.tf L2](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/versions.tf#L2). El lock nativo de S3 existe en Terraform ≥ 1.10 y OpenTofu ≥ 1.10.
5. **Instalación en la plataforma:** Ansible descarga OpenTofu 1.13.9 y verifica su sha256 ([defaults L4](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/plataforma/defaults/main.yml#L4), [tasks L83](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/plataforma/tasks/main.yml#L83)).

**Demostración:** crear un tenant eligiendo **OpenTofu**. En el log aparece `OpenTofu has been successfully initialized!`, y en las versiones de la operación `opentofu 1.13.9` con los providers de `registry.opentofu.org`.

**Preguntas probables:**
- *¿Por qué existe OpenTofu?* Terraform cambió su licencia a BSL en 2023; OpenTofu mantiene la licencia libre (MPL).
- *¿Se puede pasar un tenant de un motor al otro?* El estado es compatible, pero la plataforma guarda el motor elegido por tenant y no ofrece ese cambio.
- *¿Diferencias que notaron?* Para este código, ninguna funcional: cambian el binario y el registro de providers.

**Pasa a:** "¿Y si no usamos HCL, sino el servicio nativo de AWS?" → CloudFormation.

---

## 3. CloudFormation: implementación reducida nativa de AWS

**En una frase:** plantillas YAML que AWS ejecuta como un *stack*; el estado lo guarda AWS, no nosotros.

**Qué hace aquí:** tercer motor (RF-08), con un stack `asistencia-<id>` por tenant. Permite crear, suspender, reanudar, eliminar y reintentar; restaurar queda para Terraform.

**Recorrido por el código:**

1. **La plantilla:** [cloudformation/tenant.yaml](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloudformation/tenant.yaml). Comparar con el módulo de Terraform:
   - Parámetros: [L14](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloudformation/tenant.yaml#L14).
   - SG: [L52](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloudformation/tenant.yaml#L52).
   - Rol con boundary: [L69-L73](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloudformation/tenant.yaml#L69-L73).
   - Volumen: [L99](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloudformation/tenant.yaml#L99).
   - EC2: [L112](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloudformation/tenant.yaml#L112).
   - Conexión del volumen como `/dev/sdf`: [L129](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloudformation/tenant.yaml#L129).
2. **El motor del worker:** [cloudformation.js](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/motores/cloudformation.js) tiene la misma interfaz que el de Terraform. Lo interesante son las **limitaciones de CloudFormation** que tuvimos que resolver:
   - No admite SecureString → el motor crea el secreto antes del stack: [L75](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/motores/cloudformation.js#L75).
   - No hay recurso para detener una EC2 → suspender usa `stop-instances`: [L150](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/motores/cloudformation.js#L150).
   - Si la creación falla, el stack queda en `ROLLBACK_COMPLETE` y no admite cambios → el reintento lo borra y lo crea de nuevo: [L158](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/motores/cloudformation.js#L158).
   - No hay `plan -destroy` → la previsualización lista los recursos del stack: [L209](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/motores/cloudformation.js#L209).
   - Un parámetro admite 4 KB y cloud-init pesa 4,1 KB → se envía comprimido con gzip: [L126](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/motores/cloudformation.js#L126).
   - El despliegue: `aws cloudformation deploy` ([L177](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/motores/cloudformation.js#L177)); si falla, se leen los eventos del stack para dar un error comprensible ([L50](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/worker/motores/cloudformation.js#L50)).

**Demostración:** crear un tenant con **CloudFormation**, abrir la consola de AWS → CloudFormation → stack `asistencia-<id>` → pestañas *Resources* y *Events*. Después, **Eliminar** en el panel: la lista de 7 recursos sale del stack.

**Preguntas probables:**
- *¿Ventaja frente a Terraform?* No hay archivo de estado que proteger: lo guarda AWS. También hay rollback automático si algo falla.
- *¿Desventaja?* Solo AWS, sin vista previa del borrado y menos flexible al reintentar ([arquitectura.md §6](arquitectura.md#6-comparación-técnica-de-los-motores)).
- *¿Por qué no restaura?* Es una implementación reducida; restaurar exige reemplazar el volumen manteniendo el snapshot entre actualizaciones, y se dejó solo en Terraform.

**Pasa a:** "La tercera alternativa usa un lenguaje de programación de verdad…" → Pulumi.

---

## 4. Pulumi: infraestructura con TypeScript (comparación)

**En una frase:** la infraestructura se escribe en un lenguaje general (TypeScript), con clases, funciones y tipos.

**Qué hace aquí:** **no está integrado en la plataforma.** El enunciado pide para Pulumi "segunda implementación pequeña **o** comparación técnica"; cubrimos Pulumi con la comparación, y en el repo queda la versión del práctico anterior como ejemplo de código. Conviene decirlo así, con claridad.

**Recorrido por el código** ([asistencia-infra/pulumi](https://github.com/GatoJustiniano/asistencia-infra/tree/main/pulumi), del práctico anterior):

1. **Programa principal:** [index.ts](https://github.com/GatoJustiniano/asistencia-infra/blob/main/pulumi/index.ts). Lee la configuración del *stack* (`pulumi.Config`), compone tres componentes (red, seguridad, cómputo) y exporta la URL.
2. **Componentes:** [componentes/computo.ts](https://github.com/GatoJustiniano/asistencia-infra/blob/main/pulumi/componentes/computo.ts). Una clase `ComponentResource` que agrupa recursos, igual que un módulo de Terraform pero con orientación a objetos.
3. **Outputs asíncronos:** [componentes/cloudInit.ts](https://github.com/GatoJustiniano/asistencia-infra/blob/main/pulumi/componentes/cloudInit.ts). `pulumi.all(...).apply(...)` combina valores que solo se conocen al desplegar; es el concepto clave de Pulumi.
4. **Stacks por entorno:** [Pulumi.dev.yaml](https://github.com/GatoJustiniano/asistencia-infra/blob/main/pulumi/Pulumi.dev.yaml) y `Pulumi.prod.yaml`; en la plataforma serían un stack por tenant.
5. **La comparación:** [arquitectura.md §6](arquitectura.md#6-comparación-técnica-de-los-motores) (estado, reintentos, previsualizar el borrado, secretos, ajuste a esta plataforma).

**Por qué no se integró:** el worker tendría que instalar Node y el CLI de Pulumi y gestionar un backend de estado propio. Además, este código crea **su propia VPC** y usa las variables viejas de cloud-init, así que habría que rehacerlo como el módulo `tenant`. Detalle para mencionar como lección: `index.ts` usa `"admin123"` como clave por defecto; en la plataforma eso se resolvió generando el secreto y guardándolo en SSM.

**Demostración (opcional):** `pulumi preview` muestra el plan, como `terraform plan`. Si no hay tiempo, basta con mostrar el código y la tabla de comparación.

**Preguntas probables:**
- *¿Cuándo elegirían Pulumi?* Cuando la infraestructura tiene mucha lógica (bucles, condiciones, pruebas unitarias) o el equipo prefiere un lenguaje conocido.
- *¿Cómo guarda los secretos?* Los cifra dentro del estado (`config.getSecret`, `encryptionsalt`).

**Pasa a:** "Sea cual sea el motor, la EC2 arranca desde una imagen que preparamos antes…" → Packer.

---

## 5. Packer: la imagen base de los tenants

**En una frase:** construye una AMI (imagen de máquina) con todo lo que no cambia entre tenants, para que cada uno arranque rápido y siempre igual.

**Qué hace aquí:** genera `asistencia-tenant-<fecha>` sobre Amazon Linux 2023, con Node.js, node_exporter y la caché de dependencias de la app. **No tiene datos ni secretos** de ningún tenant.

**Recorrido por el código** ([asistencia-infra/packer](https://github.com/GatoJustiniano/asistencia-infra/tree/main/packer)):

1. **Fuente:** [asistencia.pkr.hcl L21-L27](https://github.com/GatoJustiniano/asistencia-infra/blob/main/packer/asistencia.pkr.hcl#L21-L27). Parte de la AL2023 más reciente y lanza una instancia temporal en nuestra red ([L39](https://github.com/GatoJustiniano/asistencia-infra/blob/main/packer/asistencia.pkr.hcl#L39)). Abre SSH solo a la IP de quien construye ([L47](https://github.com/GatoJustiniano/asistencia-infra/blob/main/packer/asistencia.pkr.hcl#L47)).
2. **Provisión:** [scripts/base.sh](https://github.com/GatoJustiniano/asistencia-infra/blob/main/packer/scripts/base.sh). Paquetes ([L7](https://github.com/GatoJustiniano/asistencia-infra/blob/main/packer/scripts/base.sh#L7)), node_exporter con el colector systemd ([L10](https://github.com/GatoJustiniano/asistencia-infra/blob/main/packer/scripts/base.sh#L10), [L34](https://github.com/GatoJustiniano/asistencia-infra/blob/main/packer/scripts/base.sh#L34)), caché de npm de la app ([L52](https://github.com/GatoJustiniano/asistencia-infra/blob/main/packer/scripts/base.sh#L52)), un archivo con las versiones incluidas ([L57](https://github.com/GatoJustiniano/asistencia-infra/blob/main/packer/scripts/base.sh#L57)) y limpieza final ([L68](https://github.com/GatoJustiniano/asistencia-infra/blob/main/packer/scripts/base.sh#L68)).
3. **Error que encontramos:** `execute_command` debe pasar las variables a `sudo` ([L90](https://github.com/GatoJustiniano/asistencia-infra/blob/main/packer/asistencia.pkr.hcl#L90)); sin `{{ .Vars }}` el script fallaba con "unbound variable".
4. **Tag `Rol=ami-tenant`** ([L68](https://github.com/GatoJustiniano/asistencia-infra/blob/main/packer/asistencia.pkr.hcl#L68)): así la encuentra Terraform, que toma la más reciente ([modules/tenant/main.tf L16](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf#L16), [L156](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf#L156)). Con `ignore_changes = [ami]` ([L196](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf#L196)), una AMI nueva no recrea los tenants que ya existen.

**Demostración:** en la consola EC2 → AMIs, la imagen `asistencia-tenant-…` con sus tags. En una operación de creación, la AMI usada aparece registrada en las versiones (RF-13). Construirla en vivo tarda unos 6 minutos: mejor mostrar el `manifest.json` o un log guardado.

**Preguntas probables:**
- *¿Por qué no instalar todo con cloud-init?* Se puede (es el plan B si no hay AMI), pero cada arranque descargaría y compilaría todo. Con la imagen, el tenant está listo en unos 2 minutos y siempre con las mismas versiones.
- *¿Y si hay que actualizar Node?* Se construye una AMI nueva; la usan los tenants nuevos y los que se recreen.

**Pasa a:** "La imagen es genérica; lo propio de cada institución se configura al arrancar…" → cloud-init.

---

## 6. cloud-init: el primer arranque de cada tenant

**En una frase:** un script que la EC2 ejecuta **una sola vez**, en su primer arranque, para convertir la imagen genérica en el servidor de *una* institución.

**Qué hace aquí:** monta el volumen de datos, lee el secreto del tenant, escribe la configuración de la app (incluido el nombre de la institución), instala la app y la arranca.

**Recorrido por el código** ([cloud-init/cloud-init.yaml](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloud-init/cloud-init.yaml)):

1. **Es una plantilla:** Terraform reemplaza `${TenantId}`, `${Plan}`, etc. ([modules/tenant/main.tf L172](https://github.com/GatoJustiniano/asistencia-infra/blob/main/terraform/modules/tenant/main.tf#L172)); `$${...}` queda como variable de shell. CloudFormation la renderiza igual desde el worker.
2. **Plan B sin AMI:** [L20](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloud-init/cloud-init.yaml#L20) instala Node si la imagen no lo trae.
3. **Volumen de datos:** [L24-L34](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloud-init/cloud-init.yaml#L24-L34). Espera a que se conecte, **solo formatea si está vacío** (así un volumen restaurado conserva sus datos) y lo monta en `/var/lib/asistencia`.
4. **Secreto desde SSM:** [L41](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloud-init/cloud-init.yaml#L41). Lo lee con el rol IAM de la instancia: el secreto **no viaja en el user data**.
5. **Configuración de la app:** [L49-L53](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloud-init/cloud-init.yaml#L49-L53). El nombre de la institución llega en base64 para que tildes o comillas no rompan el script.
6. **App y servicio:** [L74](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloud-init/cloud-init.yaml#L74) (clona solo `backend/` y `frontend/`), la unidad systemd ([L82](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloud-init/cloud-init.yaml#L82)) y `runcmd` ([L99](https://github.com/GatoJustiniano/asistencia-infra/blob/main/cloud-init/cloud-init.yaml#L99)).
7. **En la plataforma** también hay cloud-init: [infra/plataforma/cloud-init.yaml L10-L18](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/infra/plataforma/cloud-init.yaml#L10-L18). Instala Ansible y lo ejecuta, con un `flock` para que no corra dos veces a la vez.

**Demostración:** con Session Manager en un tenant, `sudo tail -30 /var/log/cloud-init-output.log`, `findmnt /var/lib/asistencia` y `sudo grep -v ADMIN_KEY /etc/asistencia.env` (sin mostrar la clave). En el navegador, el título de la app con el nombre de la institución.

**Preguntas probables:**
- *¿Por qué los secretos no van en el user data?* El user data se puede leer desde la consola y desde la propia instancia; por eso se lee SSM con permisos limitados a ese tenant.
- *¿Qué pasa si se reinicia la EC2?* cloud-init no vuelve a ejecutarse; el disco se monta por `fstab` y la app arranca como servicio.

**Pasa a:** "Los tenants se configuran una vez y no se tocan; la plataforma sí necesita cambios continuos…" → Ansible.

---

## 7. Ansible: configuración de la EC2 de la plataforma

**En una frase:** describe el estado deseado de un servidor (paquetes, archivos, servicios) en tareas idempotentes; ejecutarlo dos veces no cambia nada que ya esté bien.

**Qué hace aquí:** configura **la EC2 de la plataforma** (no los tenants): Prometheus, blackbox_exporter, Grafana, y el portal, la API y el worker con Node, Terraform y OpenTofu.

**Recorrido por el código** ([ansible/](https://github.com/GatoJustiniano/plataforma-tenants/tree/main/ansible)):

1. **El playbook:** [plataforma.yml](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/plataforma.yml#L10). Tiene cuatro roles: `prometheus`, `blackbox`, `grafana` y `plataforma`.
2. **Cómo llega a la máquina, sin SSH:**
   - Ansible no funciona como nodo de control en Windows, así que la instancia se lo aplica a sí misma.
   - Terraform comprime la carpeta ([main.tf L150](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/infra/plataforma/main.tf#L150)) y la sube a S3 ([L156](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/infra/plataforma/main.tf#L156)) junto con las variables del catálogo ([L51](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/infra/plataforma/main.tf#L51), [L163](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/infra/plataforma/main.tf#L163)).
   - Una asociación de SSM con el hash del paquete ([L475](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/infra/plataforma/main.tf#L475)) vuelve a ejecutarlo cuando algo cambia.
3. **Rol `plataforma`** ([tasks/main.yml](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/plataforma/tasks/main.yml)):
   - Swap ([L6](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/plataforma/tasks/main.yml#L6)).
   - Node con sha256 verificado ([L58](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/plataforma/tasks/main.yml#L58)).
   - Terraform y OpenTofu ([L83](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/plataforma/tasks/main.yml#L83)).
   - Clonar el código ([L133](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/plataforma/tasks/main.yml#L133)) y `npm ci` solo si cambió ([L141](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/plataforma/tasks/main.yml#L141)).
   - La clave desde SSM con `no_log` ([L154](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/plataforma/tasks/main.yml#L154)).
   - Los servicios systemd ([L180](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/plataforma/tasks/main.yml#L180)).
4. **Rol `grafana`:** lee la clave de admin desde SSM ([L22-L25](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/grafana/tasks/main.yml#L22-L25)), crea la cuenta de servicio de solo lectura ([L134](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/grafana/tasks/main.yml#L134)) y guarda su token en SSM ([L181](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/grafana/tasks/main.yml#L181)).

**Demostración:** ejecutarlo en vivo y mostrar el resumen: la mayoría de las tareas en `ok`, pocas en `changed`, ninguna en `failed`. Eso es idempotencia.

```bash
aws ssm send-command --instance-ids i-03fffd497e2250e61 --document-name AWS-RunShellScript --parameters commands=/usr/local/bin/aplicar-ansible.sh
```

Después, en la consola de Systems Manager → Run Command, abrir la salida (*PLAY RECAP: ok=49 changed=3 failed=0*).

**Preguntas probables:**
- *¿Por qué los tenants no usan Ansible?* Son inmutables: si cambia algo, se recrean desde la AMI y cloud-init. La plataforma, en cambio, se actualiza a menudo (código, dashboard, alertas) sin recrearla.
- *¿Dónde están las claves?* En SSM; el playbook las lee en el servidor y nunca están en el repositorio.

**Pasa a:** "Uno de los roles instala el monitoreo…" → Grafana.

---

## 8. Grafana y Prometheus: métricas y alertas

**En una frase:** Prometheus recoge métricas cada pocos segundos; Grafana las muestra en paneles y dispara alertas cuando algo se sale de lo normal.

**Qué hace aquí:** RF-25 a RF-29. Disponibilidad, CPU, memoria, disco, peticiones, errores 5xx, latencia y estado de la base de cada tenant, con filtros por tenant, plan y entorno, y 7 alertas que también se ven en el panel de la plataforma.

**Recorrido por el código:**

1. **De dónde salen las métricas:**
   - node_exporter, que viene en la AMI de Packer.
   - La app ([metricas.js](https://github.com/GatoJustiniano/asistencia-app/blob/main/backend/utils/metricas.js)): peticiones ([L11](https://github.com/GatoJustiniano/asistencia-app/blob/main/backend/utils/metricas.js#L11)), estado de la base ([L39](https://github.com/GatoJustiniano/asistencia-app/blob/main/backend/utils/metricas.js#L39)), en un puerto aparte que solo abre a la plataforma ([L66](https://github.com/GatoJustiniano/asistencia-app/blob/main/backend/utils/metricas.js#L66)).
   - blackbox, que sondea `/api/health` desde fuera.
2. **Descubrimiento automático:** [prometheus.yml.j2 L29](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/prometheus/templates/prometheus.yml.j2#L29). Prometheus pregunta a EC2 qué instancias tienen `Componente=tenant`: no hay una lista de tenants. Hay un *job* por plan con el intervalo del catálogo ([L51-L57](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/prometheus/templates/prometheus.yml.j2#L51-L57)), y los tags se convierten en etiquetas ([L59](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/prometheus/templates/prometheus.yml.j2#L59)).
3. **Dashboard como código:** [tenants.json](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/grafana/files/tenants.json#L2). Variables de entorno, plan y tenant ([L19](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/grafana/files/tenants.json#L19)); no se edita a mano.
4. **Alertas como código:** [alertas.yml.j2](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/grafana/templates/alertas.yml.j2#L6). Los umbrales salen del catálogo. `noDataState: OK` ([L79](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/ansible/roles/grafana/templates/alertas.yml.j2#L79)) evita falsas alertas de tenants suspendidos.
5. **Integración con la plataforma (RF-29):** [api/grafana.js](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/api/grafana.js). Lee las reglas por la API de Grafana con un token de **solo lectura** guardado en SSM ([L18](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/api/grafana.js#L18), [L45](https://github.com/GatoJustiniano/plataforma-tenants/blob/main/api/grafana.js#L45)).

**Demostración (la más vistosa):**
1. Mostrar el dashboard en Grafana filtrado por un tenant y por entorno.
2. Detener la app de ese tenant ([operacion.md](operacion.md#monitoreo-y-alerta-de-ejemplo)): *Servicio caído* pasa a "en observación" y a los 2 minutos a "disparada".
3. Mostrarla en la vista **Monitoreo** del panel, con el tenant y la hora de detección.
4. Arrancar la app y ver que se resuelve.

**Preguntas probables:**
- *¿Por qué Prometheus y no solo Grafana?* Grafana no guarda métricas: las consulta. Prometheus las recoge y las almacena.
- *¿Cómo se aísla el monitoreo?* Los puertos de métricas de un tenant solo aceptan tráfico del SG de la plataforma; desde internet están cerrados ([aislamiento.md](aislamiento.md#2-red)).
- *¿Qué pasa con un tenant nuevo?* Aparece solo en menos de un minuto, sin tocar la configuración.

---

## Cierre (quien presente el final)

Repetir el recorrido en una línea: **Terraform/OpenTofu/CloudFormation** crean los recursos → la EC2 arranca desde la AMI de **Packer** → **cloud-init** la convierte en el servidor de una institución → **Ansible** mantiene la plataforma → **Grafana** vigila a todos.

Terminar con la evidencia de aislamiento ([aislamiento.md](aislamiento.md)): un tenant lee su secreto y se le deniega el de otro.
