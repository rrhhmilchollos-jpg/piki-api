# PIKI API — estructura operativa

- `server.ts`: composición HTTP, autenticación y rutas.
- `models.ts`: persistencia MongoDB Atlas e índices.
- `integrations/`: adaptadores de Stripe, Signaturit, Customer y Passkeys.
- `algorithms/`: contratos versionados de dispatch, movilidad por baja actividad, sanciones y workflow.
- `auth.ts` / `employeeAuth.ts`: roles, owner-only y sesiones.
- `scripts/`: smoke tests y simulaciones no destructivas.

Las carpetas `integrations/` y `algorithms/` son índices de composición; las implementaciones continúan separadas para facilitar pruebas y despliegues independientes.
