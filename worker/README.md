# worker

Toma las operaciones pendientes (crear, suspender, reanudar, eliminar), clona asistencia-infra en el tag configurado, ejecuta terraform, tofu, pulumi o cloudformation y guarda el progreso, los outputs y las versiones usadas. Antes de guardar los logs les quita los secretos.
