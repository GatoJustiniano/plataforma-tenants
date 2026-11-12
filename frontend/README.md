# frontend

Panel de administración de la plataforma ("Tenant Control Center"), basado en el mockup del enunciado. Es HTML, CSS y JavaScript sin frameworks, y lo sirve la API en http://localhost:4000.

| Vista | Ruta | Requisitos |
|---|---|---|
| Inicio | `#/inicio` | Resumen de tenants por estado y operaciones recientes |
| Tenants | `#/tenants` | Búsqueda por nombre, estado, plan y entorno (RF-14) |
| Crear tenant | `#/tenants/nuevo` | Wizard de 3 pasos: datos y plan, motor de IaC, revisión (RF-03, RF-07, RF-08) |
| Detalle | `#/tenants/:id[/op/:n]` | Acciones de ciclo de vida, historial, progreso y log en vivo, errores y versiones (RF-11, RF-12, RF-13, RF-16, RF-18) |
| Planes | `#/planes` | Catálogo completo de `catalogo/planes.json` (RF-01, RF-02) |
| Monitoreo | `#/monitoreo` | Pendiente: integración con Grafana (RF-25 a RF-29) |
| Auditoría | `#/auditoria` | Todas las operaciones: quién, cuándo, duración y resultado |
| Configuración | `#/configuracion` | Usuario y clave de administrador de esta sesión (solo `sessionStorage`) |

Archivos:
- `js/api.js`: cliente de la API y utilidades. Todo el contenido que llega de la API se escapa antes de insertarlo en el HTML.
- `js/vistas.js`: las vistas.
- `js/app.js`: el router por hash.

Eliminar un tenant son dos pasos: primero se previsualiza la lista de recursos y datos que se borrarán, y después hay que escribir el identificador del tenant para confirmar.
