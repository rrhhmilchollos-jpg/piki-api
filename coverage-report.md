# Reporte de tests y cobertura — Engagement y Checkout

Fecha de ejecución: 2026-11-01.

## Validaciones

- `pnpm run check`: correcto.
- `pnpm test`: **174 tests pasados, 0 fallos**.
- `pnpm run build`: correcto.
- `git diff --check`: correcto.

## Cobertura enfocada

Comando ejecutado:

```bash
pnpm exec c8 --all \
  --include='src/customerEngagement.ts' \
  --include='src/stripe.ts' \
  --include='src/customerCompat.ts' \
  --reporter=text --reporter=json --reporter=html \
  pnpm exec tsx --test \
    src/customerEngagement.test.ts \
    src/checkoutOrigin.test.ts \
    src/customerCompat.input.test.ts \
    src/customerCompat.batch.test.ts
```

Resultado: **16 tests pasados, 0 fallos**.

| Archivo | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| `customerEngagement.ts` | 63,47% | 85,71% | 54,54% | 63,47% |
| `customerCompat.ts` | 37,30% | 41,55% | 59,09% | 37,30% |
| `stripe.ts` | 19,13% | 66,66% | 16,66% | 19,13% |
| **Total enfocado** | **35,46%** | **48,93%** | **46,66%** | **35,46%** |

## Cobertura con la suite completa

Comando ejecutado:

```bash
pnpm exec c8 --all \
  --include='src/customerEngagement.ts' \
  --reporter=text --reporter=json --reporter=html \
  pnpm test
```

Resultado: **174 tests pasados, 0 fallos**.

| Archivo | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| `customerEngagement.ts` | 63,47% | 85,71% | 54,54% | 63,47% |

El informe HTML completo está en `coverage-full/index.html`.

## Optimizaciones realizadas

1. La probabilidad de la ruleta se extrajo a `resolveWheelReward()`, con límites explícitos `[0, 0,60)` y una ruta segura para valores no finitos.
2. Las rachas usan `nextCustomerStreak()` y sólo continúan cuando el pedido ocurre en el día UTC inmediatamente siguiente. Los eventos fuera de orden ya no prolongan una racha.
3. Se añadió `CustomerOrderCompletion` con índice único por pedido para evitar duplicados bajo reintentos concurrentes.
4. La creación del registro de cumplimiento, actualización de racha y concesión de badges se ejecutan dentro de una transacción MongoDB.
5. La concesión de badges pasó de escrituras secuenciales a `bulkWrite` idempotente.
6. Las recomendaciones ignoran identificadores de restaurante que no sean ObjectId válidos.
7. Se añadió el script reproducible `pnpm run test:coverage`.

## Cobertura pendiente

No se ejecutaron pruebas de integración contra MongoDB Atlas ni contra Stripe porque este entorno no tiene configurados secretos o una `MONGODB_URI` de staging. La cobertura existente valida reglas puras, contratos tRPC y construcción de checkout; una prueba E2E de persistencia requiere un MongoDB de pruebas y claves Stripe de test aisladas.
