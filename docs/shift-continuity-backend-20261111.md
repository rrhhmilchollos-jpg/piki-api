# Continuidad de turnos: corrección backend del 11/11/2026

## Alcance

El reloj de enforcement usa `Europe/Madrid`, incluyendo CET/CEST y cambios de fecha locales. `timezoneOffsetMinutes` se conserva como campo legado compatible, pero ya no decide el reloj oficial. No se modifica el handler GET `/api/v1/riders/:id/shift`, el frontend ni el contrato de deliveries.

Para el barrido, un `RiderSlot` vigente, `planned` o `active`, del mismo rider y tenant sustituye únicamente la franja del plan antiguo. Se reutiliza la política existente de intervalos, con inicio inclusivo y fin exclusivo. Antes de elegir esa franja se comprueba la validez del plan original y que sus horas planificadas no superen las contratadas. Sin slot vigente se mantiene el fallback al plan. No se crean ni se reescriben asignaciones.

La cuota semanal sigue siendo 10/20/30/40 horas. Un slot de servicio 12:00–00:00 no autoriza a un mismo individuo a trabajar 84 horas semanales: al agotarse su cuota real el barrido conserva el corte, cierre del slot, desconexión, revocación de sesiones y tratamiento existente de pedidos. Las reglas de abandono y estados seguros de reasignación no cambian.

## Fichajes y cómputo

`RiderSlot.startedAt` es opcional. POST `/shift/start` fija la hora del servidor únicamente en la transición `planned` → `active`, mediante actualización condicional atómica. Un reintento activo no mueve el inicio ni fabrica uno para un slot legacy. Si la transición pierde una carrera contra un cierre/cancelación, no se habilita al rider. Se conservan los controles de acceso y ubicación reciente.

POST `/shift/stop` cierra únicamente slots activos y registra `stoppedAt` del servidor y `stoppedReason: rider_stopped`. Los reintentos no sobrescriben el fin ni vuelven a liquidar el seguimiento. No convierte un slot nunca iniciado en tiempo trabajado. Se conserva el bloqueo por reparto activo.

El contador usa intersecciones de instantes: inicio real, fin real si existe, límites programados del slot, semana local lunes 00:00–lunes 00:00 y hora actual. `stoppedAt` se respeta también en días históricos y slots todavía marcados activos; un inicio tardío no cuenta desde el inicio programado. Se incluye la posible cola nocturna del domingo anterior, contando solo la parte dentro de la semana consultada. En cambios DST se cuenta tiempo efectivamente transcurrido.

**Política legacy explícita:** sin `startedAt` se conserva el inicio programado como estimación ya existente. Sin `stoppedAt`, el límite es el fin programado (y nunca un instante futuro). Esto cubre el cierre natural de `expireRiderSlots`, que sigue marcando `completed` sin timestamp de fin. No se usan `createdAt`, `updatedAt` ni supuestos para reconstruir fichajes históricos; no se ejecuta ningún backfill.

## Límites y verificación

No hay garantía de continuidad más allá del fin exclusivo del slot ni al agotarse la cuota. El barrido conserva su frecuencia y su revocación actual; resolver entregas en curso en el borde, cambios de contrato/UX o convivencia de estados/sesiones requiere trabajo separado. Sin un plan guardado se conserva el comportamiento existente del barrido, sin inventar un contrato. Un GET de snapshot del plan sigue reflejando el plan y no el reemplazo interno utilizado solo por el barrido.

Los intervalos legacy sin fichajes siguen siendo estimaciones, no evidencia de horas reales. Slots solapados continúan sumándose según la política previa; esta corrección no reconstruye ni deduplica históricos. Límites civiles inexistentes por cambio DST o timestamps inválidos no se reconstruyen; deben corregirse desde datos verificables. Para una hora repetida, los límites programados se resuelven conservadoramente con inicio más temprano y fin más tardío, recortados por fichajes reales si existen.

Las pruebas cubren invierno/verano, medianoche y DST, paradas históricas, inicio tardío, caducidad natural, semana local, legacy, plan discrepante con slot vigente, cuota real, fallback y controles de los handlers. Los handlers y el barrido se ejecutan con persistencia en memoria; conexiones, listeners y transporte externo quedan bloqueados. El pipeline de Mongo se comprueba con un evaluador de expresiones en memoria, no con una base de datos real. Antes de despliegue corresponde validar compatibilidad del Mongo objetivo con updates por pipeline (MongoDB 4.2+) y realizar revisión operativa autorizada.

Se instala con `pnpm@10.4.1 install --frozen-lockfile`, sin alterar dependencias ni lockfiles. El pin existente reporta scripts bloqueados de `esbuild`, `@firebase/util` y `protobufjs`; `esbuild` y `tsx` funcionan mediante sus binarios instalados. No se amplían permisos ni se cambia la configuración de paquetes en esta corrección.

La validación se completó antes del commit y de guardar la propuesta en GitHub. No se realiza deploy, migración ni acceso a APIs o bases de datos de producción.

## Resultados locales

- `pnpm install --frozen-lockfile`: correcto, gestor efectivo `10.4.1`, dependencias exactas del lockfile. `pnpm ignored-builds` muestra las advertencias ya descritas; `pnpm exec esbuild --version` devuelve `0.25.12` y `pnpm exec tsx --version` devuelve `4.23.15`.
- `pnpm check`: correcto (`tsc --noEmit`), tanto antes como después de la corrección.
- `pnpm build`: correcto; compila `server` y `dispatch-worker`, sin ejecutarlos.
- Regresiones de shift/calendario: 52 pruebas correctas. Integración nueva de handlers/barrido: 8 pruebas correctas.
- Batería completa aislada: `PIKI_NO_LISTEN=true NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null node --import tsx --require /tmp/piki-api-offline-guard-20261111.cjs --test --test-concurrency=2 src/*.test.ts`: **379 correctas, 0 fallidas, 0 omitidas**. El preload temporal bloquea sockets/listeners, HTTP(S), TLS y `fetch`; los tests solo sustituyen esos transportes cuando ofrecen respuestas simuladas. El warning Mongoose sobre el campo reservado `errors` ya existe en el esquema de auditoría y no se cambia.
- `git diff --check`: correcto. Validación sobre la base `4ee77ba0c633979bc68f4a27c352d5c8b8c01803`, rama `fix/rider-shift-enforcement-madrid-20261111`. Guardar esta propuesta no implica fusionarla en `main` ni desplegarla.
