# PIKI API

**PIKI API** es el núcleo común para PIKI Delivery, Partners, Riders, Fleet y Control. Es un servicio Node.js/Express preparado para MongoDB Atlas y desplegable como servicio Docker en Render.

## Estado actual

La API implementa comprobaciones de salud, catálogo de restaurantes, alta de partners y resúmenes operativos para los paneles de administración, riders y flotas. El catálogo inicial contiene los seis establecimientos preservados de la web oficial: Solera Cocina Viva, Taller Verde, Forno Rossi, Nori Club, Brasa Callejera y Miga Dulce.

La conexión de Atlas no se guarda en el repositorio. La variable `MONGODB_URI` debe configurarse en el entorno de Render antes de desplegar. Se puede sembrar el catálogo inicial únicamente en un entorno de prueba con `SEED_DEMO_DATA=true`.

## Migración formal a tenants

La API incorpora `tenants`, `tenant_memberships` y `tenantId` indexado en las entidades operativas. La migración es idempotente y crea el tenant raíz `piki-platform` para los datos existentes.

En Render, ejecutar primero una comprobación:

```bash
pnpm run migrate:tenants
```

Para aplicar el backfill en producción, configurar temporalmente `ALLOW_TENANT_MIGRATION=true` en el entorno protegido y ejecutar:

```bash
PIKI_ROOT_TENANT_SLUG=piki-platform \
PIKI_ROOT_TENANT_NAME="PIKI Delivery" \
ALLOW_TENANT_MIGRATION=true \
pnpm run migrate:tenants -- --apply
```

El script no permite `--apply` sin `ALLOW_TENANT_MIGRATION=true`, informa los recuentos antes de escribir y termina desconectando MongoDB. Después de verificar los recuentos, retirar inmediatamente `ALLOW_TENANT_MIGRATION` del entorno.

## Desarrollo local

```bash
cp .env.example .env
npm install
npm run dev
```

Con una URI de Atlas configurada, el catálogo se carga mediante:

```bash
npm run seed
```

## Endpoints iniciales

| Método | Ruta | Propósito |
|---|---|---|
| `GET` | `/health` | Comprueba que el proceso HTTP responde. |
| `GET` | `/ready` | Comprueba que MongoDB Atlas está conectado. |
| `GET` | `/api/v1/catalog/restaurants` | Devuelve establecimientos activos y permite filtrar por categoría o texto. |
| `POST` | `/api/v1/partners/onboarding` | Registra una solicitud de partner para revisión. |
| `GET` | `/api/v1/admin/overview` | Resume comercios, riders y pedidos de operaciones. |
| `GET` | `/api/v1/riders/overview` | Resume carga y actividad de riders. |
| `GET` | `/api/v1/fleets/overview` | Resume flotas y pedidos operativos. |
| `POST` | `/api/v1/orders` | Valida catálogo, recalcula importes y crea un pedido pendiente de pago. |
| `POST` | `/api/v1/payments/checkout` | Crea una Checkout Session de Stripe usando los importes guardados en MongoDB. |
| `POST` | `/api/webhooks/stripe` | Endpoint canónico Stripe: verifica `Stripe-Signature`, deduplica, autoriza el pago y solo lo captura al validar la entrega. |
| `POST` | `/api/v1/payments/webhook` | Alias compatible del endpoint canónico Stripe. |
| `GET` | `/api/v1/realtime/events` | Stream SSE autenticado y reanudable de eventos operativos por superficie. |
| `GET` | `/api/v1/fleets/pending-partner-orders` | Cola Fleet de pedidos pagados que esperan aceptación del Partner. |

## Configuración Stripe en modo test

La API no activa pagos por defecto. Para un entorno de pruebas se deben configurar únicamente en el gestor de secretos del entorno:

```text
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

En la cuenta **Stripe test**, configura el endpoint de staging exacto **`https://piki-api-staging.onrender.com/api/webhooks/stripe`**. Suscríbelo, como mínimo, a `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `checkout.session.async_payment_failed`, `checkout.session.expired` y `charge.refunded`. La ruta histórica `/api/v1/payments/webhook` sigue disponible como alias compatible, pero el endpoint canónico es `/api/webhooks/stripe`.

Stripe requiere el cuerpo crudo para verificar la firma; por eso la ruta se registra antes de `express.json()`. Los eventos se deduplican en la colección `stripe_events` usando `event.id`, con estados `processing`/`processed`/`failed`: sólo quedan `processed` después de actualizar el pedido y persistir el outbox de tiempo real. El cliente no debe marcar un pedido como pagado a partir de `success_url`: la confirmación válida es el webhook firmado.

## Flujo de pedido pagado en tiempo real

1. El webhook válido actualiza exclusivamente el estado de pago de forma idempotente; no modifica `status`, `assignmentState`, rider ni otros datos operacionales. Un pedido intacto en `pending/unassigned` recibe el outbox de intake una sola vez.
2. La API escribe eventos persistentes en `realtime_events` (retención de 24 h) y los entrega por SSE; MongoDB Change Streams los replica cuando Render usa más de una instancia.
3. Partner recibe `order.awaiting_partner_acceptance` y mantiene la alarma hasta pulsar **Aceptar pedido**. Fleet lo muestra en **Pedidos por asignar** y no reserva rider todavía. Admin recalcula GMV y pedidos abiertos.
4. Customer recibe el texto de estado en directo. Rider solo recibe una oferta después de la aceptación del Partner y de la reserva segura de asignación.

Los clientes deben enviar `X-PIKI-Surface`, credenciales válidas y conservar `Last-Event-ID`; así pueden recuperar eventos tras una pérdida temporal de red sin solicitar un refresco manual.

## Seguridad de configuración

El archivo `.env` no se versiona. Las credenciales se configuran en Render y los clientes solo consumen la API pública a través de HTTPS. Los orígenes autorizados se controlan con `CORS_ORIGINS`.

## Próxima integración

La siguiente iteración introduce autenticación por rol, una máquina de estados transaccional de pedido, pagos y el motor de asignación de riders. El modelo ya contiene índices por categoría, actividad, estado de pedido, identificador público y geoíndices para las posiciones que se habilitarán al activar el servicio de localización.


### Rutas y pagos retenidos

El API intenta calcular cada ruta restaurante → cliente con Google Maps Directions usando `GOOGLE_MAPS_API_KEY`. Si Google no responde, utiliza OSRM; si ambos fallan, marca `routingDegraded=true` y aplica la restricción conservadora de vehículos. La duración persistida se usa en el ranking de Riders.

Stripe usa `capture_method=manual`: `payment_intent.amount_capturable_updated` deja el pedido en `authorized`, lo que permite el despacho sin considerar el dinero liquidado. La captura se ejecuta idempotentemente después de QR/PIN válido en `confirm-delivery`; solo entonces el pedido pasa a `paymentState=paid`. Para el rollout manual se recomienda validar primero tarjeta compatible; **Bizum no se anuncia como habilitado por esta API**. No se ha cambiado la configuración de métodos de pago en producción. Los pedidos `cash` no pasan por Stripe.

### Límites de seguridad de Stripe

- Esta documentación describe **test/staging**; no configura ni afirma una prueba E2E, cobro, webhook o KYC/payout real en producción.
- Los nombres indicadores permitidos son `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET`; sus valores sólo deben existir en el gestor de secretos del entorno. Nunca se incluyen claves en código, documentación, logs o respuestas HTTP.
- Antes de habilitar pagos online a clientes, validar mediante un ensayo aislado el webhook firmado, autorizaciones, captura manual, reintentos, replays y eventos fuera de orden. La configuración de métodos de pago y cualquier cambio de producción requieren aprobación separada.
- La entrega tolera que `payment_intent.succeeded` incremente la versión justo después de `capture()`: el webhook no toca el estado operacional y el cierre condiciona `on_the_way`/rider/asignación, no una versión antigua. **Sigue pendiente** una saga o conciliación para el caso de caída del proceso después de que Stripe capture y antes de persistir `delivered`, y para hacer atómico el ledger de efectivo con la entrega.

## Sincronización del catálogo Partners → Customers

`GET /api/v1/catalog/events` es un stream SSE público, separado del stream autenticado de pedidos. Solo comunica `catalog.updated` con una razón y, cuando el restaurante ya es público, identificadores públicos; nunca envía cartas completas, contactos, documentos, pedidos ni datos de empleados. El evento `ready` obliga a Customers a consultar de nuevo el catálogo al conectar/reconectar.

Las mutaciones de carta/publicación, estado y horarios notifican después de guardar. MongoDB Change Streams sobre `restaurants` distribuye también las actualizaciones entre instancias de Render y detecta cambios realizados desde Admin. Si el relay falla temporalmente, siguen disponibles los eventos locales y la revalidación periódica de Customers. `GET /api/v1/catalog/restaurants` lee MongoDB y responde `Cache-Control: no-store`, sin snapshots de catálogo en Redis o memoria que puedan devolver productos o precios antiguos.

Los datos operativos de Mr Rooster ya no se restablecen en cada arranque. Los valores del portfolio de la reparación de acceso se aplican con `$setOnInsert`, no sobre cartas existentes. Esto conserva los cambios actuales, pero no recupera ediciones que un arranque anterior ya hubiera sobrescrito; su recuperación requiere una copia histórica o volver a guardarlas en Partners.
