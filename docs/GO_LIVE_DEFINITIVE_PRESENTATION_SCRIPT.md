# PIKI Delivery — Guion de presentación del PDF de GO-LIVE definitivo

## Duración y objetivo

Duración recomendada: 10–12 minutos.

El objetivo es que el equipo termine con una decisión clara: el software está validado, el primer GO-LIVE debe seguir con MongoDB Atlas, y la promoción queda condicionada a completar Atlas, Render, DNS, Vercel y las pruebas de aceptación.

## Página 1 — Propósito y decisión de arquitectura

“Este documento es el runbook operativo para el GO-LIVE definitivo de PIKI. La decisión principal es separar el primer GO-LIVE de la migración MySQL/Drizzle. MongoDB Atlas continúa siendo la fuente de verdad hasta que exista una migración completa, reconciliable y reversible.”

## Página 2 — Estado ejecutivo

“El código está en verde: el chequeo TypeScript pasa, los 114 tests pasan y el build genera tanto el servidor como el worker. El Outbox MongoDB ya incorpora leases, backoff, idempotencia y dead-letter.”

“Los estados pendientes no son correcciones de lógica: Atlas está pendiente de configuración, DNS está pendiente, Vercel tiene un bloqueo de SSO y Render necesita configurar y validar los servicios.”

## Página 3 — Variables y despliegue Render

“La rama preparada configura dos procesos. El web service recibe tráfico HTTP y mantiene `PIKI_INLINE_DISPATCH_WORKER=false`. El Background Worker `piki-dispatch-worker` ejecuta `npm run start:dispatch-worker`.”

“Ambos servicios usan la misma `MONGODB_URI`, pero no se debe sustituir la lista completa de variables al actualizar Render. El script usa el endpoint individual para evitar borrar secretos o configuración existente.”

## Página 4 — Atlas como prerrequisito

“Antes de configurar Render debemos tener el cluster de Atlas activo, el usuario de aplicación creado, la red de Render permitida y un backup verificable. La URI se guarda solo como secreto de Render.”

“No se debe pegar la URI real en Git, logs, tickets o chats. El valor de `MONGODB_DB` debe ser `piki` salvo que la infraestructura de staging utilice una base aislada.”

## Página 5 — Health checks y dominios

“En el servicio web, `/health` confirma que el proceso está vivo y no requiere MongoDB. `/ready` confirma que el proceso puede operar contra MongoDB y debe devolver 503 si Atlas no está disponible.”

“Los checks definitivos se hacen contra el hostname público del API y, después de DNS, contra `https://api.pikidelivery.com`.”

“El worker tiene endpoints propios, pero un Background Worker no debe asumirse públicamente accesible. Su estado se valida por logs, métricas y el mecanismo interno de observación disponible en Render.”

## Página 6 — Staging y pruebas de Outbox

“Staging debe usar un cluster y datos separados. Se crea un pedido sintético y se comprueba que existe un único evento lógico por `idempotencyKey`.”

“Después se prueban tres situaciones: dos workers compitiendo por el mismo evento, expiración y recuperación de un lease, y retry de un error transitorio. El evento agotado debe llegar a dead-letter sin duplicar la oferta.”

## Página 7 — Go-live, rollback y MySQL posterior

“El GO-LIVE se aprueba cuando Atlas, Render, DNS y Vercel están operativos, los checks devuelven los estados esperados, el pedido sintético se procesa una sola vez y existe rollback probado.”

“Si readiness falla, aumentan los 5xx o aparecen dead-letters inesperados, se vuelve al último deployment bueno, se preservan los documentos del Outbox y se investiga sin truncar la cola.”

“MySQL/Drizzle queda fuera de esta ventana. Requiere esquema de dominio, backfill, dual-write, shadow-read, reconciliación, consumidores idempotentes, pruebas de concurrencia y rollback.”

## Decisiones que debe tomar el equipo

1. Confirmar que MongoDB Atlas es la fuente de verdad del primer GO-LIVE.
2. Confirmar quién proporciona los IDs de los servicios Render y quién ejecuta el deploy.
3. Confirmar la ventana de staging y la ventana de producción.
4. Aprobar el criterio de rollback.
5. Resolver la protección SSO de Vercel.
6. Confirmar que la migración MySQL/Drizzle será un proyecto posterior y no una condición oculta del primer lanzamiento.

## Cierre recomendado

“El siguiente paso seguro no es cambiar una URI ni hacer un cutover de base de datos. Es completar Atlas, configurar los dos servicios Render, validar `/health` y `/ready`, probar el Outbox en staging y solo después promover el API y los frontends. El software está preparado; la aprobación definitiva depende de cerrar los recursos y accesos externos.”
