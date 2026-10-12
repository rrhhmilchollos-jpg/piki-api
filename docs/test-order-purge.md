# Purga segura de pedidos de prueba

## Estado

Este cambio añade rutas al backend; **no ejecuta ninguna eliminación en producción**. Para usarlas, primero hay que fusionar el cambio y desplegar la API. No se incluye ni se necesita una clave nueva de entorno.

## Alcance fijo

El preview selecciona únicamente pedidos que cumplen al menos uno de estos criterios:

- `isTestOrder: true`;
- tienen un `qaRiderId`;
- pertenecen a un restaurante cuyo nombre completo coincide exactamente con `KFC XATIVA QA`, ignorando mayúsculas, espacios iniciales/finales y espacios repetidos.

No se borra el restaurante ni se borran cuentas de restaurante, clientes, empleados o riders. Para los riders de prueba, si el pedido de simulación tiene el campo `activeOrderId` apuntando al pedido que se elimina, se borra esa referencia y el rider de prueba se pasa a `offline`; su cuenta se conserva.

## Barreras antes del borrado

Solo se permite borrar:

- pedidos cancelados con estado de pago `pending`, `failed` o `expired`; o
- pedidos de la simulación QA aislada del backend (`isTestOrder`, `qaRiderId` asociado a un Rider con `isTestRider: true`, sin asignación a un rider real), antes de recogida.

El pedido se bloquea si tiene un pago autorizado, pagado o reembolsado; referencia de Stripe; cobro en efectivo; entrada de caja; evento Stripe; incentivo ligado; rider real con el pedido activo; o ticket de soporte que no sea el ticket QA generado (`sourceRole: "qa"` y número `SUP-QA-...`). Los tickets QA exactos que acompañan la simulación aislada sí se eliminan; el historial de soporte ordinario nunca se borra automáticamente.

La transacción elimina también eventos de `dispatch_outbox`, decisiones de dispatch, reservas de asignación, mensajes Rider↔pedido y notificaciones referidas al pedido. Se registra una auditoría permanente con el actor, los IDs/códigos públicos y el recuento eliminado. **No** se conservan direcciones ni datos personales del pedido en la auditoría. El libro de caja y los eventos Stripe se conservan siempre.

Para pedidos QA todavía activos, el tablero de Partner ofrece un botón individual únicamente cuando el API identifica un marcador de prueba o el restaurante exacto `KFC XATIVA QA`. El botón requiere permiso `orders:cancel` y confirmación explícita. El API vuelve a comprobar tenant/local, estado, referencias de pagos/caja/Stripe/incentivos y tickets. Si es seguro, elimina en una transacción el pedido y sus tareas/relaciones operativas QA, libera `activeOrderId` del Rider y escribe auditoría; conserva las cuentas del restaurante, Partner y Rider. No borra pedidos recogidos/en ruta/entregados ni casos ordinarios de soporte.

Los pedidos entregados o en ruta no se borran mediante esta herramienta, aunque tengan marca QA. Los candidatos bloqueados aparecen en el preview para revisión. La operación requiere MongoDB en replica set o mongos; sin transacciones la API responde `503 MONGODB_TRANSACTION_REQUIRED` y no recurre a un borrado parcial.

## Flujo de dos fases

Ambas rutas requieren la sesión de propietario/superadmin de la API y tienen rate limit.

### 1. Crear preview

`POST /api/v1/admin/maintenance/test-orders/preview`

Cuerpo exacto:

```json
{
  "scope": "test-markers-plus-exact-kfc-xativa-qa"
}
```

La respuesta presenta cada candidato sin datos personales, con su disposición (`eligible`/`blocked`) y códigos de bloqueo. Si hay pedidos elegibles, también entrega `previewId`, `previewToken`, `expiresAt`, `counts.eligible` y una `confirmationPhrase` como `ELIMINAR 3 PEDIDOS DE PRUEBA`.

El preview dura 10 minutos y queda ligado al propietario que lo creó. El token se entrega una sola vez, solo se guarda su hash y el índice TTL elimina previews expirados. Se aceptan hasta 250 candidatos por preview; si hay más, la API devuelve `413 TOO_MANY_TEST_ORDER_CANDIDATES` y no crea un token.

### 2. Confirmar exactamente el preview

`POST /api/v1/admin/maintenance/test-orders/delete`

Cuerpo:

```json
{
  "previewId": "<id devuelto por preview>",
  "previewToken": "<token devuelto por preview>",
  "expectedDeleteCount": 3,
  "confirmationPhrase": "ELIMINAR 3 PEDIDOS DE PRUEBA"
}
```

Los valores se copian de la respuesta previa. El API vuelve a evaluar todos los candidatos dentro de una transacción y aborta con `409 PREVIEW_STALE_REVIEW_REQUIRED` si cambió cualquier dato o referencia. El token es de un solo uso; repetir la confirmación falla. La cantidad y la frase deben coincidir exactamente.

La respuesta exitosa incluye el número y los códigos públicos borrados, el ID de auditoría y confirmación de que restaurante y cuentas se conservaron.

## Errores importantes

- `403 INVALID_PREVIEW_TOKEN`: token incorrecto.
- `410 PREVIEW_EXPIRED_USED_OR_NOT_OWNED`: preview expirado, consumido o de otro usuario.
- `409 PREVIEW_STALE_REVIEW_REQUIRED`: cambió el conjunto o estado; crear un preview nuevo.
- `409 QA_RESTAURANT_NAME_AMBIGUOUS`: hay más de un restaurante con ese nombre exacto; se bloquea el proceso.
- `413 TOO_MANY_TEST_ORDER_CANDIDATES`: más de 250 candidatos en un solo preview.
- `503 MONGODB_TRANSACTION_REQUIRED`: configuración MongoDB sin transacciones; no se ejecuta borrado parcial.

Las rutas antiguas de borrado directo (`POST /api/v1/admin/orders/cleanup-test-data` y `DELETE /api/v1/admin/qa/dispatch-orders/:id`) quedan deprecadas y responden `410 SAFE_TEST_ORDER_PURGE_REQUIRED` para impedir que se omitan preview, límites financieros y transacción.
