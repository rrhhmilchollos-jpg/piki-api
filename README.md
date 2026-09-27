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
| `POST` | `/api/webhooks/stripe` | Endpoint canónico Stripe: verifica `Stripe-Signature`, deduplica y activa el pedido pagado. |
| `POST` | `/api/v1/payments/webhook` | Alias compatible del endpoint canónico Stripe. |
| `GET` | `/api/v1/realtime/events` | Stream SSE autenticado y reanudable de eventos operativos por superficie. |
| `GET` | `/api/v1/fleets/pending-partner-orders` | Cola Fleet de pedidos pagados que esperan aceptación del Partner. |

## Configuración Stripe en modo test

La API no activa pagos por defecto. Para un entorno de pruebas se deben configurar únicamente en el gestor de secretos del entorno:

```text
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Configura en Stripe el endpoint público **`https://api.pikidelivery.com/api/webhooks/stripe`** y suscríbelo, como mínimo, a `checkout.session.completed`, `checkout.session.async_payment_succeeded` y `payment_intent.succeeded`. La ruta histórica `/api/v1/payments/webhook` sigue disponible para no romper configuraciones anteriores.

Stripe requiere el cuerpo crudo para verificar la firma; por eso la ruta se registra antes de `express.json()`. Los eventos se deduplican en la colección `stripe_events` usando `event.id`. El cliente no debe marcar un pedido como pagado a partir de `success_url`: la confirmación válida es el webhook firmado.

## Flujo de pedido pagado en tiempo real

1. El webhook válido mueve de forma idempotente el pedido a `paymentState=paid`, `status=pending` y `assignmentState=unassigned`.
2. La API escribe eventos persistentes en `realtime_events` (retención de 24 h) y los entrega por SSE; MongoDB Change Streams los replica cuando Render usa más de una instancia.
3. Partner recibe `order.awaiting_partner_acceptance` y mantiene la alarma hasta pulsar **Aceptar pedido**. Fleet lo muestra en **Pedidos por asignar** y no reserva rider todavía. Admin recalcula GMV y pedidos abiertos.
4. Customer recibe el texto de estado en directo. Rider solo recibe una oferta después de la aceptación del Partner y de la reserva segura de asignación.

Los clientes deben enviar `X-PIKI-Surface`, credenciales válidas y conservar `Last-Event-ID`; así pueden recuperar eventos tras una pérdida temporal de red sin solicitar un refresco manual.

## Seguridad de configuración

El archivo `.env` no se versiona. Las credenciales se configuran en Render y los clientes solo consumen la API pública a través de HTTPS. Los orígenes autorizados se controlan con `CORS_ORIGINS`.

## Próxima integración

La siguiente iteración introduce autenticación por rol, una máquina de estados transaccional de pedido, pagos y el motor de asignación de riders. El modelo ya contiene índices por categoría, actividad, estado de pedido, identificador público y geoíndices para las posiciones que se habilitarán al activar el servicio de localización.
