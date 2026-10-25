# PIKI — Guion de presentación del estado Go-live

## Objetivo y duración

Duración recomendada: 8–10 minutos.

El mensaje central es que el código base está validado y el worker de dispatch ya está preparado para ejecutarse como servicio independiente, pero la salida a producción sigue dependiendo de Atlas, DNS, Render y Vercel.

## 1. Estado técnico actual

“Partimos de un API que compila correctamente y tiene 114 pruebas automatizadas pasando. La persistencia actual es MongoDB con Mongoose. El dispatch outbox ya tiene idempotency key, leases atómicos, backoff y dead-letter.”

“Por tanto, el bloqueo inmediato no es una corrección de lógica de negocio. Es completar la infraestructura real de producción y validar el despliegue controlado.”

## 2. Cambio aplicado para el worker

“Se ha preparado la separación del worker de dispatch del proceso web. El API mantiene el tráfico HTTP y Render ejecuta un servicio Background Worker con `npm run start:dispatch-worker`.”

“En producción el worker inline del API queda desactivado mediante `PIKI_INLINE_DISPATCH_WORKER=false`. Esto evita mezclar el ciclo de vida HTTP con el procesamiento de la cola.”

“Los dos procesos utilizan la misma `MONGODB_URI`, pero el worker tiene su propio proceso, logs y health endpoints.”

## 3. Health checks

“`/health` es el liveness check. Devuelve 200 para indicar que el proceso HTTP está vivo y no depende de MongoDB.”

“`/ready` es el readiness check. Solo devuelve 200 cuando la conexión MongoDB está disponible. Si Atlas está caído o la URI es incorrecta, devuelve 503.”

“Para el worker, `/health` y `/ready` se sirven en el puerto configurado y `/metrics` expone el estado operativo del proceso.”

## 4. Pendiente: MongoDB Atlas

“Antes del deploy hay que crear o confirmar el proyecto y cluster `PIKI DELIVERY`, crear un usuario con privilegios mínimos y configurar la red de Render.”

“La URI de Atlas nunca se coloca en Git ni en el archivo `render.yaml`. Se introduce como secreto directo en el servicio web y en el worker.”

“Después se verifica un backup y una restauración de prueba.”

## 5. Pendiente: Render

“Render debe tener dos servicios conectados a la misma rama y al mismo cluster: `piki-api` y `piki-dispatch-worker`.”

“Primero se configura la URI y las variables. Después se despliega staging, se validan `/health`, `/ready` y `/metrics`, y se genera un pedido sintético para comprobar que el Outbox se procesa una sola vez.”

“No se debe activar producción hasta observar que el worker recupera leases expirados, reintenta errores transitorios y envía los agotados a dead-letter.”

## 6. Pendiente: DNS y Vercel

“`api.pikidelivery.com` necesita resolver públicamente y apuntar al servicio Render. Los dominios frontend necesitan estar operativos y reflejados en CORS.”

“Los despliegues nuevos de Vercel están bloqueados por la protección SSO del equipo. Hay que resolver esa protección o desplegar con un acceso autorizado antes de promover las versiones nuevas.”

## 7. Decisión sobre MySQL/Drizzle

“MySQL/Drizzle no debe entrar en el mismo cutover que el primer go-live MongoDB. El API real contiene muchos modelos MongoDB y el Outbox actual está integrado en dispatch.”

“La ruta segura es estabilizar primero MongoDB Atlas y el worker dedicado. Después se puede ejecutar una migración separada con esquema SQL completo, backfill, dual-write, shadow-read, consumidores idempotentes y rollback.”

## 8. Criterios de aceptación

“Consideraremos listo el go-live cuando se cumplan estos puntos: `/health` devuelve 200, `/ready` devuelve 200 con Atlas conectado, el worker está operativo, el pedido sintético produce un único evento lógico, no hay errores sostenidos de claim, las alertas están activas y el dominio API responde por DNS.”

“Además, debe existir un rollback documentado y probado. Si falla readiness, suben los 5xx o aparecen divergencias, se vuelve a la versión conocida y se conserva la evidencia.”

## Cierre

“La conclusión es que el software base está en estado verde de validación, pero la infraestructura externa todavía está en ámbar. El siguiente paso no es cambiar la URI a ciegas: es completar Atlas, Render y DNS, desplegar el worker separado en staging y promover solo después de los checks de aceptación.”
