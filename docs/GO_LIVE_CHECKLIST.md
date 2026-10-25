# PIKI API — Go-live checklist

## Baseline verificado

- `npm run check` pasa.
- `npm test` pasa: 114 tests.
- La API usa MongoDB/Mongoose en producción.
- El dispatch outbox actual usa leases, backoff, idempotency key y dead-letter.
- `/health` es liveness y `/ready` valida la conexión MongoDB.

## Cambio aplicado en esta rama

- Render web service: `PIKI_INLINE_DISPATCH_WORKER=false`.
- Render background worker: `piki-dispatch-worker`.
- El worker ejecuta `npm run start:dispatch-worker` con el mismo Dockerfile.
- El worker tiene su propio `MONGODB_URI`, `MONGODB_DB`, batch y polling.
- Se mantiene MongoDB como fuente de verdad; no se activa MySQL sin una migración de dominio completa.

## Antes de desplegar

- [ ] Crear/verificar proyecto y cluster `PIKI DELIVERY` en MongoDB Atlas.
- [ ] Crear usuario de base de datos con mínimo privilegio necesario.
- [ ] Permitir la red de Render en Atlas; evitar credenciales en Git.
- [ ] Configurar `MONGODB_URI` como secreto en los servicios web y worker.
- [ ] Verificar backup y restore de Atlas.
- [ ] Resolver DNS de `pikidelivery.com` y `api.pikidelivery.com`.
- [ ] Asociar `api.pikidelivery.com` al servicio Render.
- [ ] Resolver la protección SSO de Vercel para poder promover los despliegues actuales.
- [ ] Configurar CORS definitivo después de validar los dominios.

## Despliegue controlado

1. Desplegar la rama en staging.
2. Confirmar que API y worker conectan a la misma base de staging.
3. Comprobar API:

```bash
curl -i https://<staging-api>/health
curl -i https://<staging-api>/ready
```

4. Comprobar worker:

```bash
curl -i http://<worker-host>:10000/health
curl -i http://<worker-host>:10000/metrics
```

5. Generar un pedido de prueba y verificar:
   - Se crea un único `dispatch_outbox` por `idempotencyKey`.
   - Dos workers no ofrecen dos veces el mismo pedido.
   - Un lease expirado se recupera.
   - Los errores transitorios hacen retry.
   - Los eventos agotados pasan a `dead_letter`.
6. Promover a producción durante una ventana observada.
7. Mantener el worker inline desactivado cuando el worker dedicado esté estable.

## Criterios de aceptación

- `/health` devuelve HTTP 200 sin depender de MongoDB.
- `/ready` devuelve HTTP 200 solo con MongoDB conectado.
- El worker dedicado devuelve HTTP 200 mientras está operativo.
- El worker dedicado devuelve HTTP 503 durante shutdown.
- No hay errores sostenidos de claim o publicación.
- No aumenta la tasa de pedidos sin asignación por un problema de worker.
- Hay backup y rollback documentados.

## Bloqueos que no se pueden resolver solo con código

- Credenciales y cluster de MongoDB Atlas.
- Configuración de DNS/Cloudflare.
- Protección SSO de Vercel.
- Acceso de producción a Render y promoción del servicio.
- Decisión formal de si MySQL/Drizzle es requisito de v1 o una migración posterior.

No cambiar la fuente de persistencia a MySQL hasta disponer de un esquema completo para las entidades de dominio, backfill verificado, dual-write, shadow-read, consumidores idempotentes y rollback probado.
