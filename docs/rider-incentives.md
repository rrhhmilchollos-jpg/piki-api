# Incentivos de Rider — contrato y operación

El módulo se integra en las rutas y datos existentes de PIKI. No duplica pedidos, turnos, cálculo de liquidación ni eventos de despacho.

## Reutilización

- `src/settlements.ts`: fuente de cálculo de remuneración por entrega y nuevo helper para el complemento horario.
- `dispatch_decisions`: origen de ofertas; el estado se actualiza al aceptar, rechazar o expirar.
- `RiderSlot`, `Order`, `Zone`: fuente de turnos, entregas y polígonos geoespaciales.
- `src/riderIncentivesModels.ts`: solo añade perfiles de referido, métricas mínimas de presencia, ledger idempotente y reserva de presupuesto.

## API rider

- `GET /api/v1/riders/:id/incentives`: muestra estado activo, reglas, código, progreso y ledger del rider autenticado.
- `POST /api/v1/riders/:id/referrals/claim` con `{ "code": "PIKI-XXXXXXXX" }`: asocia una invitación una sola vez y antes de la primera entrega.

Los hitos se evalúan al confirmarse entregas reales, excluyendo órdenes de prueba. Cada recompensa actualiza el presupuesto global y crea su entrada de ledger en la misma transacción; los dos bonos del invitado y del invitador se conceden juntos en una sola transacción. La clave única del evento evita duplicados; las colisiones al inicializar el bucket mensual o repetir un hito se reintentan de forma acotada. No se realizan transferencias bancarias.

## Condiciones de activación

Por defecto los flags están en `false` y el presupuesto en 0. Para activar cada parte se requieren:

- `PIKI_RIDER_REFERRALS_ENABLED=true` para códigos y bonos de adquisición/referido.
- `PIKI_HOURLY_GUARANTEE_ENABLED=true` para el cálculo y devengo de complementos.
- `PIKI_RIDER_INCENTIVES_MONTHLY_CAP_CENTS` con un límite global positivo (céntimos EUR).
- `PIKI_RIDER_INCENTIVES_START_AT` como fecha/hora ISO efectiva de la campaña de referidos; evita premiar usuarios preexistentes.
- `PIKI_HOURLY_GUARANTEE_ZONE_SLUG` para identificar la zona central; en PIKI Xàtiva el valor por defecto es `xativa-centro`.

El límite global reserva fondos antes de otorgar recompensas y bloquea nuevas entradas cuando se agota. La base Mongo debe soportar transacciones (por ejemplo, un replica set o clúster sharded) para activar cualquiera de los premios. El límite frena nuevos devengos, pero no pre-reserva por adelantado el máximo de garantía de cada turno todavía no completado; esa exposición requiere supervisión operativa adicional.

## Estado del payout

`earned` es un importe devengado en el ledger, no una transferencia ni una confirmación de pago. La conciliación/cuenta de payout deberá integrarse en el proceso financiero existente antes de presentar el saldo como retirable.
