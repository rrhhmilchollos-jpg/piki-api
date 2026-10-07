# Actualización inmediata del calendario Rider

## Flujo

1. Fleet guarda o modifica un turno mediante la API autenticada. Para semanas, envía `weekdays` (0=lunes … 6=domingo) y la API guarda los días seleccionados en una sola transacción. Si el campo no existe, se mantienen los siete días por compatibilidad. Las listas vacías o con días repetidos se rechazan; no se aceptan semanas de referencia pasadas.
2. Una vez confirmado el commit, la API persiste/publica `rider.schedule_updated` para la audiencia privada `rider:<riderId>`, con el rider, la acción y una marca temporal. El evento se publica **después** del commit: no se notifica un horario que haya sido revertido por conflicto de presupuesto o validación.
3. Rider, conectado al SSE autenticado, recibe el evento y pide inmediatamente su agenda vigente (`GET /api/v1/riders/:id/slots`) y el estado actual del turno (`GET /api/v1/riders/:id/shift`). El calendario se reemplaza con la respuesta del backend.
4. Al iniciar sesión o volver a abrir/mostrar la app, Rider carga de nuevo la agenda. Esto cubre los cambios hechos mientras la app estaba cerrada o sin conexión.

No hay sondeo periódico de slots. La comprobación ligera periódica de `/shift` solo actualiza la ventana/estado de la jornada, no descarga el calendario.

## Mutaciones que emiten el evento

- `POST /api/v1/rider-slots`: asignación individual.
- `POST /api/v1/rider-slots/week`: asignación de los días seleccionados, todos-o-ninguno.
- `PATCH /api/v1/rider-slots/:id`: modificación.
- `DELETE /api/v1/rider-slots/:id`: cancelación lógica.
- `POST /api/v1/riders/:id/slots`: ruta alternativa existente de asignación.

Los endpoints Fleet verifican que la cuenta tenga `fleetId`, que el rider pertenezca a la flota y que la zona esté dentro de cobertura. Los slots activos o completados no se sobrescriben. La reserva de garantía y el slot comparten transacción; un rechazo de presupuesto deja la agenda intacta y no emite evento.

## Semántica de la respuesta Fleet

`riderNotified: true` significa que la API pudo registrar/publicar el evento realtime. Si da `false`, el horario igualmente quedó guardado y la UI explica que el Rider verá el cambio al abrir la app; no se revierte un commit correcto por una interrupción del canal de notificaciones.

## Archivos

- Publicación dirigida: `src/realtime.ts`.
- Registro de rutas, permisos, transacción y publicación post-commit: `src/server.ts`.
- Listener SSE y recarga puntual del calendario: `piki-rider/src/realtime.ts` y `piki-rider/src/App.tsx`.
- Guardado individual/semanal y feedback: `piki-fleet/src/App.tsx`.
