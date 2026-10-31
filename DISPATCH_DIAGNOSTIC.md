# Diagnóstico y corrección del dispatch de PIKI

## Causa principal

La creación de pedidos sí persiste la intención de dispatch en `dispatch_outbox` para pedidos en efectivo y tras confirmar Stripe. Sin embargo, el mecanismo de recuperación (`runAutomaticDispatchSweep`) no se ejecutaba en el fallback inline de la API. El worker dedicado sí lo llamaba, pero si ese servicio no estaba levantado, la API solo consumía eventos ya existentes y no encontraba/encolaba pedidos pendientes antiguos.

Además, la consulta automática de riders limitaba a 100 resultados sin `$near`; el diagnóstico/manual sí usaba `nearRestaurant`, pero el camino real podía seleccionar un conjunto incorrecto y no aplicaba de forma explícita el radio de 25 km.

## Otros fallos corregidos

- Las reservas de rider tienen `orderId` único. Tras liberar una reserva, una reasignación intentaba insertar otra reserva para el mismo pedido y podía fallar con `E11000`, aunque el rider siguiera disponible.
- Los errores de red o timeout de Google Maps escapaban directamente al fallback general: en vez de intentar OSRM, el flujo terminaba en ruta degradada.
- Los eventos `no_eligible_rider` y `missing_geolocation` se trataban como candidatos a dead-letter tras demasiados intentos. Ahora se mantienen como reintentables, con una clave de recuperación estable por versión del pedido.
- La ETA sumaba preparación y viaje a recogida de forma secuencial, aunque ambas tareas pueden solaparse. Ahora usa `max(preparación, viaje a recogida) + entrega`.

## Ubicación y disponibilidad

El backend sí recibe y persiste las coordenadas como GeoJSON `[longitude, latitude]` y `lastLocationAt`, y rechaza GPS con más de 90 segundos. La selección también exige un turno actual (`RiderSlot`) y estado `available`/`busy`; por tanto, un rider puede verse online en la interfaz pero quedar fuera del dispatch si no tiene una franja activa, no tiene GPS fresco o no tiene coordenadas válidas.

## Cambios aplicados

- `src/server.ts`: sweep periódico desde el worker de respaldo, recuperación paginada, consulta geoespacial real y validación de coordenadas.
- `src/dispatchReservation.ts`: reserva reutilizable por pedido y tolerancia a carreras entre workers.
- `src/dispatchOutbox.ts`: claves de recuperación y clasificación de reintentos.
- `src/dispatch-worker.ts`: mantenimiento periódico y política común de retries/dead-letter.
- `src/coverage/routing.ts`: fallback Google Maps → OSRM también ante excepciones de red.
- `src/dispatch.ts`: ETA sin doble conteo de preparación.

## Validación

```text
npm run check       OK
tsc --noEmit        OK
npm test            169 passed, 0 failed
npm run build       OK
 git diff --check   OK
```

No se ejecutó contra MongoDB/Vercel/Render de producción y no se desplegaron cambios. El acceso de lectura a Render no estaba autorizado, por lo que la confirmación final en producción requiere revisar `/health`, métricas del worker, documentos `dispatch_outbox` y logs del servicio.
