# Estrategia de notificaciones para supermercados y tiendas locales de Xàtiva

## Alcance

Esta estrategia se aplica a comercios de categoría `Supermercado`, `Alimentación`, `Hogar y regalos`, `Mascotas`, `Farmacia` y otras tiendas locales que operen dentro de la geocerca **Xàtiva Casco Urbano**. No activa localidades de Fase 2 ni crea comercios sin expediente verificado.

El importador los deja inicialmente en `pending_review`, `coming_soon` e `isActive: false`. La activación comercial se realiza solo después de revisar documentación, cuenta Partner, catálogo, horarios y capacidad de preparación.

## Canales y destinatarios

| Evento | Partner | Rider/Fleet | Admin | Customer |
|---|---:|---:|---:|---:|
| Pedido nuevo pagado | Inbox + sonido visual | Oferta normal | Métrica | Confirmación |
| Pedido de supermercado con cesta grande | Inbox + alerta de capacidad | Oferta priorizada a coche | Alerta operativa | Confirmación |
| Producto agotado o sustitución requerida | Alerta urgente | — | Incidencia | Solicitud de sustitución |
| Partner no acepta en 3 min | Escalado | Fleet informada | Alerta alta | Estado pendiente |
| Preparación supera SLA | Alerta urgente | Aviso de retraso | Alerta alta | Retraso transparente |
| Pedido listo para recoger | Inbox + sonido | Oferta/aviso de recogida | Métrica | Actualización |
| Rider llega al comercio | Confirmación | Estado GPS | Métrica | — |
| Cancelación por falta de stock | Alerta + motivo | Aviso de no recogida | Incidencia | Reembolso/alternativa |

## Reglas específicas de supermercados y tiendas

### 1. Capacidad y vehículo

- Carritos con más de 8 unidades, productos voluminosos o peso estimado superior a 8 kg deben marcarse como `large_basket`.
- `large_basket` prioriza coche y evita reservar el patinete.
- Pedidos de hasta 5 unidades ligeras pueden seguir el dispatch normal; el patinete solo se utiliza si la distancia es corta y no hay restricciones peatonales.
- Las reglas de vehículo no sustituyen las restricciones de seguridad del rider.

### 2. Sustituciones y stock

Cada producto debe conservar `available`. Cuando el Partner marca un producto agotado:

1. Se crea una incidencia `stockout` asociada al pedido.
2. Customer recibe tres opciones: sustituir por equivalente, eliminar el producto o cancelar el pedido.
3. El pedido queda bloqueado en `awaiting_customer_substitution` con un timeout de 5 minutos.
4. Si no responde, se elimina el producto agotado y se recalcula el total antes de continuar.
5. Nunca se sustituye silenciosamente un producto de alimentación, farmacia o dieta especial.

### 3. SLA propuesto

- Aceptación del comercio: **3 minutos**.
- Confirmación de stock: **5 minutos** desde aceptación.
- Preparación inicial: **15 minutos** para cesta pequeña, **25 minutos** para cesta grande.
- Aviso preventivo: al 80% del SLA.
- Escalado urgente: al 100% del SLA.
- Reasignación o intervención manual: 5 minutos después del incumplimiento si no hay respuesta.

## Deduplificación e idempotencia

Cada evento debe usar una clave estable:

```text
local-commerce:{event}:{orderId}:{version}
```

Ejemplos:

```text
local-commerce:stockout:665abc:4
local-commerce:prep-warning:665abc:4
local-commerce:large-basket:665abc:1
```

No se debe reproducir sonido ni enviar push duplicado al reconectar una app. El cliente debe hidratar primero el estado inicial y después procesar eventos nuevos, igual que el flujo de ofertas del Rider.

## Severidades

- `info`: cambio normal de estado; inbox y realtime.
- `warning`: stock parcial o retraso preventivo; inbox + badge.
- `high`: SLA incumplido, cesta grande sin vehículo adecuado o sustitución pendiente; inbox + push a Partner/Fleet/Admin.
- `urgent`: cancelación por stock, problema de seguridad alimentaria o comercio sin respuesta; push + escalado al panel Admin.

## Payload común

```json
{
  "type": "local_commerce.stockout",
  "severity": "high",
  "orderId": "order_665abc",
  "restaurantId": "...",
  "restaurantCategory": "Supermercado",
  "publicCode": "PIKI-1234",
  "productId": "leche-entera-1l",
  "productName": "Leche entera 1 l",
  "requiresCustomerDecision": true,
  "dedupeKey": "local-commerce:stockout:..."
}
```

El esquema definitivo debe validar `orderId`, `restaurantId`, `productId` y `dedupeKey` como cadenas no vacías.

## Métricas y alertas de supervisión

Admin/Fleet debe monitorizar por comercio y por categoría:

- tasa de aceptación en menos de 3 minutos;
- tasa de sustituciones y cancelaciones por stock;
- tiempo medio de confirmación de stock;
- tiempo medio de preparación;
- porcentaje de pedidos con cesta grande;
- incidencias por 100 pedidos;
- pedidos reasignados por falta de coche;
- desconexiones del canal realtime;
- duplicados de notificación por `dedupeKey`.

Umbrales iniciales:

- aceptación < 90% en 10 pedidos: alerta `high`;
- cancelación por stock > 5% en 20 pedidos: revisión del catálogo;
- preparación fuera de SLA > 10%: revisión de horarios/capacidad;
- cualquier incidencia de seguridad alimentaria: `urgent` inmediata.

## Orden de implantación

1. Importar y validar el catálogo con `catalog:import:xativa` en dry-run.
2. Revisar precios, unidades, imágenes, disponibilidad y datos fiscales.
3. Aprobar individualmente o en lote solo los expedientes completos.
4. Activar un comercio piloto desde Admin.
5. Simular un pedido con una opción de precio individual y una baja de stock.
6. Activar alertas de SLA y revisar métricas durante los primeros 20 pedidos.
7. Solo después ampliar a otros comercios locales.
