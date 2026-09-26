# Política operativa de cobertura — Xàtiva v1

Esta política se aplica **en el servidor** antes de crear un pedido y antes de iniciar el checkout. Los clientes no calculan ni deciden el precio.

| Regla | Valor aplicado |
|---|---:|
| Centro operativo | Xàtiva (`38.990276, -0.521111`) |
| Radio máximo en línea recta | 10 km, borde incluido |
| Tarifa de entrega dentro del municipio | 1,99 € |
| Suplemento dentro de radio, fuera del municipio | +1,00 € |
| Tarifa de entrega fuera del municipio | 2,99 € |
| Tasa de servicio | 0,79 € existente, guardada y cobrada por separado |
| Umbral de ruta para vehículo robusto | Más de 3,000 km de ruta |
| Vehículos permitidos sobre el umbral | `motorcycle`, `car` |

## Garantías implementadas

1. `GET /api/v1/coverage` devuelve una decisión explicable: distancia recta, municipio, tarifa y versión.
2. `POST /api/v1/orders` devuelve **422 `DELIVERY_OUTSIDE_XATIVA_RADIUS`** sin persistir ni abrir Stripe si la dirección queda fuera de 10 km.
3. Cada pedido guarda una instantánea de cobertura, importes, proveedor de ruta, distancia de ruta y vehículos operativamente admisibles. Checkout usa esos importes persistidos.
4. Asignación automática, vista previa y asignación manual filtran los riders incompatibles con el requisito persistido de vehículo.
5. Si el proveedor de rutas no responde, el pedido sigue siendo posible pero se aplica una restricción **conservadora** de `motorcycle`/`car`; nunca se ofrece a bici o patinete por falta de medición.

## Fuente del límite municipal

El polígono local versionado procede de la relación administrativa de Xàtiva en OpenStreetMap, descargada el **2026-09-26** vía Nominatim y simplificada conservando topología (~10 m). Está incorporado en `src/coverage/xativaBoundary.ts`, de modo que el checkout no depende de una llamada externa para decidir la tarifa.

Antes de ampliar la cobertura a otra ciudad o de cambiar los precios, Operaciones debe sustituir este extracto por un límite municipal administrativamente aprobado y publicar una nueva versión de política.

## Verificación

```bash
npm run check
npx tsx scripts/check-xativa-coverage.ts
npm run build
```
