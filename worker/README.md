# worker

Toma las operaciones pendientes (crear, suspender, reanudar, eliminar), clona asistencia-infra en el tag configurado, ejecuta terraform, tofu, pulumi o cloudformation y guarda el progreso, los outputs y las versiones usadas. Antes de guardar los logs les quita los secretos.

- Toma cada operación con una sola sentencia SQL (`UPDATE ... RETURNING`), así que una operación nunca se ejecuta dos veces.
- Solo puede haber un worker en marcha: al arrancar escribe su PID en `worker/trabajos/worker.pid` y, si encuentra otro worker vivo, se niega a iniciar. Así no marca como interrumpidas las operaciones que otro está ejecutando.
- En Windows, detener `npm run worker` puede dejar vivo el proceso `node` hijo. Si el worker dice que ya hay otro en ejecución, cierra ese PID.
- Entre las versiones de cada operación guarda la AMI con la que se creó la instancia (`ami_id`, construida con Packer).
