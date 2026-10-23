# API PIKI 0.3.4 — resumen técnico tRPC

## Estado de despliegue

- Servicio: `piki-api`
- Versión de paquete: `0.3.4`
- Commit live: `6bcb486c1f835b7354231851f86fc126148da2ee`
- Rutas de salud: `GET /health` y `GET /ready`
- Catálogo central: `GET /api/v1/catalog/restaurants`
- Transporte Customer: `/api/trpc/:procedure`

## Cambio incluido en 0.3.4

La versión 0.3.4 no añade procedimientos tRPC nuevos. Corrige la proyección pública del catálogo para que el procedimiento existente `catalog.list` exponga la capacidad de pago en efectivo del comercio.

Antes, `restaurantView()` omitía `cashPaymentsEnabled`; el frontend recibía el comercio sin autorización de efectivo y mostraba `NO DISPONIBLE`, aunque la ficha de Mr Rooster estuviese autorizada en MongoDB.

Ahora la respuesta de un comercio operativo incluye:

```json
{
  "id": "6acad53e7f55ddba7e05c189",
  "name": "Mr Rooster Xàtiva",
  "availabilityStatus": "available",
  "isActive": true,
  "cashPaymentsEnabled": true,
  "menu": []
}
```

El valor se calcula mediante `isCashPaymentEnabledForRestaurant(row)`, por lo que la política central sigue bloqueando comercios no autorizados, incluido Alibaba.

## Procedimientos tRPC relevantes

### `catalog.list`

- Método: `GET` o `POST` mediante `/api/trpc/catalog.list`.
- Acceso: público.
- Cabecera de caché: `Cache-Control: no-store, max-age=0`.
- Entrada opcional: `category`, `query`.
- Devuelve: comercios activos o fichas de disponibilidad según `CUSTOMER_CATALOG_RESTAURANT_FILTER`.
- Incluye: menú filtrado por disponibilidad, modificadores, precios, estado operativo y `cashPaymentsEnabled`.

### `catalog.byId`

- Método: `GET` o `POST` mediante `/api/trpc/catalog.byId`.
- Entrada: `id` del comercio.
- Devuelve la misma proyección pública de `restaurantView()` que `catalog.list`.
- Por tanto, también expone de forma consistente `cashPaymentsEnabled`.

### `order.checkout`

- Método: mutación tRPC protegida.
- Comprueba la cuenta del cliente, dirección validada, cobertura, horario y cotización.
- Para `paymentMethod: "cash"`, exige autorización expresa del comercio y aplica el límite de 48,99 € con entrega y tasas incluidas.
- Para `paymentMethod: "stripe"`, inicia el checkout online y conserva el flujo de tarjeta/Bizum configurado.

### `order.create`

- Método: mutación pública de compatibilidad.
- Persiste el pedido canónico y publica la notificación de entrada para partners/riders.
- La ruta de checkout es la recomendada para pedidos reales porque aplica validaciones de pago y dirección completas.

## Contrato de compatibilidad

Las aplicaciones mantienen sus propias versiones de superficie:

- Customer `0.2.17`
- Rider `1.0.6`
- Admin `0.2.14`
- Fleet `0.2.13`
- Partner `0.2.11`

La compatibilidad con API `0.3.4` se verifica por el contrato tRPC, la identidad de cliente (`X-PIKI-Surface`, `X-PIKI-Client-Version`, `X-PIKI-Client-Build`) y la respuesta pública del catálogo. Los manifests de frontend no contienen actualmente un campo separado `apiVersion`.

## Pruebas

- Suite API: 86 tests correctos.
- Regresión añadida: `catalog.list` devuelve `cashPaymentsEnabled: true` para Mr Rooster.
- API live: `GET /health` y `GET /ready` responden HTTP 200.
- Verificación live: `catalog.list` devuelve `cashPaymentsEnabled: true` para Mr Rooster Xàtiva.
