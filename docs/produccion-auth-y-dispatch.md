# PIKI Delivery — autenticación Render, microservicios y dispatch PostGIS

**Estado de esta entrega:** se corrige el ciclo de reintentos 401 de los streams SSE, se añade CORS para los orígenes Render conocidos y se entrega un worker PostGIS ejecutable. **No existe aún una instancia PostGIS PIKI ni un proveedor de rutas configurado**, por lo que no es responsable declarar que el batch matching esté operativo en producción hasta completar el aprovisionamiento y las pruebas de corte indicadas al final.

## 1. Aclaración: Render no autentica a los usuarios

Render proporciona red, HTTPS, proceso y variables de entorno. La autenticación efectiva de PIKI reside en la API y MongoDB:

```text
Rider / Admin / Partner (navegador)
  │ POST /api/v1/auth/employee/login + X-PIKI-Surface
  ▼
PIKI API en Render
  │ valida contraseña, rol y estado de la cuenta
  │ emite token opaco piki_session_…
  ▼
MongoDB: employee_sessions
  ├── tokenHash (SHA-256, nunca el token en claro)
  ├── employeeId, role y surface
  ├── issuedAt
  └── expiresAt (TTL MongoDB: 7 días)
  │
  ▼
Navegador guarda el token y usa Authorization: Bearer <token>
  │
  ├── REST protegido: requireRole(...)
  └── SSE: GET /api/v1/realtime/events + X-PIKI-Surface
```

El endpoint `resolveRole()` verifica primero tokens técnicos configurados y después el hash de sesión contra `employee_sessions`. Esto permite escalar la API en Render sin afinidad de sesión: cualquier réplica consulta la misma sesión persistida en MongoDB.

Los clientes customer usan otro canal: una cookie `piki_customer_session`, también almacenada **solo como hash** en `CustomerAccount.sessionHash`. La actualización de dicho hash es ahora `await` antes de entregar la respuesta de login/registro; elimina la carrera en la que el navegador abría SSE antes de que MongoDB hubiera guardado la sesión.

## 2. Corrección aplicada a los 401 del stream SSE

### Causa confirmada

Las superficies Riders y Administración reintentaban el stream `/api/v1/realtime/events` cada **1,5 segundos** para cualquier error. Cuando el token expiraba, faltaba o el navegador abría Admin antes de iniciar sesión, cada intento devolvía `401`; el cliente no lo distinguía de un corte de red.

### Comportamiento nuevo

| Respuesta del stream | Acción del cliente | Resultado |
|---|---|---|
| `200` | Consume eventos y vuelve a marcar la conexión activa | Stream operativo |
| `401` o `428` | Borra token, cierra el stream y muestra acceso | **No hay bucle de 401** |
| `403` | Cierra el stream e informa de permiso/superficie incorrecta | No reintenta una denegación permanente |
| `429` | Respeta `Retry-After`, si existe | Protección de API |
| Red / `5xx` | Backoff exponencial con jitter, máximo 60 s | Recuperación sin martillear Render |

La API también devuelve `WWW-Authenticate: Bearer realm="PIKI API"` en el SSE no autenticado. Se han añadido a CORS los orígenes de fallback `https://piki-customer.onrender.com`, `https://piki-riders.onrender.com` y `https://piki-admin.onrender.com`; los dominios canónicos `*.pikidelivery.com` ya estaban permitidos.

## 3. Separación segura entre API y futuros microservicios

La API actual es un **monolito modular**: `server.ts`, MongoDB, módulos `algorithms/`, `integrations/` y `notifications/` viven en el mismo servicio. No se debe presentar como microservicios independientes porque aún no lo son.

Al extraer dispatch, routing o notificaciones, el contrato debe ser:

| Flujo | Identidad | Transporte | Regla de seguridad |
|---|---|---|---|
| Navegador → API | Sesión opaca de empleado o cookie customer | HTTPS público | `Authorization: Bearer` o cookie según superficie |
| Worker dispatch → PostGIS | Cuenta de base de datos dedicada | TLS a base privada | Rol SQL mínimo, sin acceso a tablas de usuario Mongo |
| Worker dispatch → API relay | Identidad de servicio de corta duración | HTTPS privado | JWT con `iss`, `aud`, `sub`, `exp`, `jti` y scopes; no reutilizar tokens de Rider |
| API relay → SSE/Push | Evento outbox validado | Cola o consumo transaccional | Idempotencia por `event_id` / `dedupe_key` |

> No existe un proveedor OIDC, una autoridad de certificados mTLS ni una cola configurada para PIKI hoy. Para una producción multi-servicio se debe elegir uno y emitir tokens de servicio de vida corta. Render **no** sustituye este control de identidad.

## 4. PostGIS: geofencing y búsqueda radial en Xàtiva

La migración [`infra/postgis/002_dispatch_geofencing_and_batch.sql`](../infra/postgis/002_dispatch_geofencing_and_batch.sql) complementa la base `001`:

1. Mantiene los polígonos de Xàtiva y pedanías como `geometry(MultiPolygon, 4326)` y las posiciones vivas como `geography(Point, 4326)`.
2. `delivery.assign_zone()` usa `ST_Covers`, por lo que el borde municipal cuenta como dentro de cobertura.
3. `delivery.nearest_eligible_riders()` filtra por zona, disponibilidad, capacidad, frescura GPS, batería y `ST_DWithin` en **metros**; un índice GiST y el operador KNN `<->` reducen el conjunto antes del orden exacto con `ST_Distance`.
4. `delivery.lock_orders_for_dispatch_batch()` usa `FOR UPDATE SKIP LOCKED`; dos workers no pueden capturar el mismo pedido.
5. `dispatch_bundles` y `dispatch_bundle_members` expresan una oferta indivisible de varios pedidos.
6. `delivery.accept_dispatch_offer()` bloquea oferta, rider y todos los pedidos del bundle antes de validar capacidad y cambiar estados. El resultado es todo o nada.
7. `dispatch_outbox` desacopla el worker espacial del relay a Mongo/SSE; no se deben realizar escrituras directas a la base pública de la API desde el worker.

## 5. Worker Node.js de batch matching

El script completo es [`scripts/run-postgis-batch.mjs`](../scripts/run-postgis-batch.mjs). Hace un ciclo para una zona:

```text
crear dispatch_batch
  → lock_orders_for_dispatch_batch (SKIP LOCKED)
  → cargar pedidos y posiciones
  → nearest_eligible_riders (PostGIS)
  → formar parejas con recogidas próximas
  → exigir ruta de carretera para bundles
  → crear bundle + offers + outbox
  → liberar pedidos sin candidato
  → guardar snapshot y cerrar batch
```

El matching de dos pedidos se activa solo si:

- comparten comercio o las recogidas quedan dentro de `PIKI_BUNDLE_PICKUP_RADIUS_METERS`;
- un rider cumple capacidad total, vehículo, GPS reciente, batería y radio;
- `PIKI_ROUTING_URL` devuelve una ruta válida de múltiples paradas;
- el itinerario no incumple las promesas de entrega;
- el desvío calculado no supera `PIKI_BUNDLE_MAX_DETOUR_SECONDS`.

Si falta el proveedor de routing, el proceso es **conservador**: ofrece singles y no fabrica bundles con distancia en línea recta.

### Contrato de routing requerido

El worker invoca:

```http
POST ${PIKI_ROUTING_URL}/v1/route/multi-stop
Authorization: Bearer ${PIKI_ROUTING_TOKEN}
Content-Type: application/json

{
  "vehicle": "moto",
  "waypoints": [
    {"kind":"rider","longitude":-0.52,"latitude":38.99},
    {"kind":"pickup","orderId":"…","longitude":-0.521,"latitude":38.991},
    {"kind":"dropoff","orderId":"…","longitude":-0.518,"latitude":38.995}
  ]
}
```

Respuesta mínima:

```json
{ "distanceMeters": 3200, "durationSeconds": 780 }
```

### Variables requeridas

| Variable | Uso |
|---|---|
| `PIKI_POSTGIS_URL` | Cadena TLS de la base PostGIS exclusiva de PIKI |
| `PIKI_POSTGIS_SSL` | `false` solo en desarrollo local; producción usa TLS |
| `PIKI_DISPATCH_ZONE_ID` | UUID de la zona activa de Xàtiva/pedanía |
| `PIKI_DISPATCH_TENANT_ID` | Por defecto `piki` |
| `PIKI_ROUTING_URL` y `PIKI_ROUTING_TOKEN` | Obligatorios para generar bundles |
| `PIKI_DISPATCH_*` | Límites de lote, radio y caducidad de oferta |

Ejemplo de ejecución tras provisionar la infraestructura:

```bash
psql "$PIKI_POSTGIS_URL" -v ON_ERROR_STOP=1 \
  -f infra/postgis/001_geofencing_xativa.sql \
  -f infra/postgis/002_dispatch_geofencing_and_batch.sql

PIKI_POSTGIS_URL='…' PIKI_DISPATCH_ZONE_ID='…' \
PIKI_ROUTING_URL='https://routing.internal.pikidelivery.com' \
pnpm dispatch:postgis
```

## 6. Lista de salida a producción: obligatoria

No se debe marcar la plataforma como “100 % lista” hasta que los siguientes puntos tengan evidencia real:

- [ ] Crear una **instancia Postgres con extensión PostGIS** en entorno PIKI, privada y con backups/verificación de restauración.
- [ ] Cargar polígonos oficiales/versionados de Xàtiva y cada pedanía; no usar estimaciones geográficas para facturación.
- [ ] Aplicar ambas migraciones en staging y ejecutar `EXPLAIN (ANALYZE, BUFFERS)` de la consulta radial con datos realistas.
- [ ] Desplegar el worker como servicio independiente con un disparador de 5–10 segundos o cola; no como cron de sesión interactiva.
- [ ] Implementar y probar el consumidor de `dispatch_outbox` que sincroniza ofertas con la API Mongo/SSE y el Push nativo.
- [ ] Configurar un proveedor de rutas con cuenta, cuotas, alertas y prueba de caída; sin él el worker seguirá degradando a singles.
- [ ] Configurar secretos en Render, nunca en repositorio; revisar `CORS_ORIGINS`, `MONGODB_URI`, claves Stripe, QR, Push y tokens internos.
- [ ] Hacer canary con cuentas de prueba: login, expiración a propósito, SSE, oferta, aceptación concurrente, cancelación, pago y rollback.
- [ ] Verificar `health` y `ready`, logs 4xx/5xx, latencia, uso de DB, alertas y runbook de reversión.

## 7. Resultado de validación local

- API: `node --check scripts/run-postgis-batch.mjs`, `pnpm check`, `pnpm test`, `pnpm build` y `git diff --check` superados.
- PIKI Customer: `pnpm check`, 8 suites y 21 pruebas superadas.
- Riders y Admin: requieren instalar dependencias bloqueadas localmente antes de compilar; el siguiente paso de la automatización valida ambos builds sin modificar sus locks.
