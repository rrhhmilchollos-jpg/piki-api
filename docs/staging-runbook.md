# PIKI Delivery: staging aislado y pruebas E2E en solitario

Este entorno sirve para probar el circuito completo de PIKI sin escribir en producción. La rama `main`, el servicio Render `piki-api` y la base `piki` no se utilizan durante las pruebas staging.

## 1. Arquitectura de aislamiento

| Elemento | Producción | Staging |
|---|---|---|
| Rama API | `main` | `staging` |
| Servicio Render | `piki-api` | `piki-api-staging` |
| MongoDB | cluster/proyecto de producción | cluster/proyecto independiente |
| Base | `piki` | `piki_staging` |
| Entorno | `NODE_ENV=production` | `NODE_ENV=staging` + `PIKI_ENVIRONMENT=staging` |
| Pagos | Stripe live | Stripe test o desactivado |
| Push | claves VAPID live | claves VAPID staging |
| Aplicaciones | dominios públicos | previews/dominios staging |

**La separación de rama no es suficiente.** La URI MongoDB, claves, webhooks, CORS, push y URLs deben ser diferentes.

## 2. Lo que ya está preparado en código

- La rama `staging` existe en el repositorio del API.
- `render.staging.yaml` declara `piki-api-staging` y la rama `staging`.
- El API arranca en staging únicamente si existe `MONGODB_URI` y `MONGODB_DB=piki_staging`.
- Staging no admite por defecto orígenes web de producción.
- `scripts/seed-staging-qa.ts` exige `NODE_ENV=staging`, `ALLOW_QA_SEED=true` y una base cuyo nombre sea de staging/QA/test.
- Los pedidos QA usan `isTestOrder=true` y quedan fuera de incentivos y métricas comerciales.
- `scripts/destroy-staging.ts` solo puede ejecutarse con `PIKI_ENVIRONMENT=staging`, `NODE_ENV=staging`, `MONGODB_DB=piki_staging` y dos confirmaciones explícitas.

## 3. Preparación única de MongoDB Atlas

Crea un proyecto separado llamado `PIKI-Staging` y un cluster separado llamado `piki-staging`.

1. Crear base `piki_staging`.
2. Crear un usuario exclusivo, por ejemplo `piki_staging_app`.
3. Concederle únicamente `readWrite` sobre `piki_staging`.
4. Añadir la IP de salida de Render o la regla de red que corresponda.
5. Activar backups/PITR si el plan lo permite.
6. Copiar la URI, pero **no pegarla en GitHub, chat ni archivos versionados**.

No uses la URI del cluster productivo, aunque cambies `MONGODB_DB`.

## 4. Crear/configurar Render staging

En Render, crea o conecta el servicio:

- Nombre: `piki-api-staging`.
- Repositorio: `rrhhmilchollos-jpg/piki-api`.
- Rama: `staging`.
- Región: Frankfurt.
- Runtime: Docker.
- Dockerfile: `./Dockerfile`.
- Health check: `/ready`.
- Plan: Starter o superior para que el sweep y SSE no se suspendan.

Variables obligatorias:

```env
NODE_ENV=staging
PIKI_ENVIRONMENT=staging
PIKI_ALLOW_TEST_ORDERS=true
MONGODB_URI=<URI-DEL-CLUSTER-STAGING>
MONGODB_DB=piki_staging
PUBLIC_API_URL=https://piki-api-staging.onrender.com
CORS_ORIGINS=<SOLO-DOMINIOS-STAGING>
```

Genera valores nuevos para todos los secretos:

```env
ADMIN_API_TOKEN=<secreto-staging>
PARTNER_API_TOKEN=<secreto-staging>
RIDER_API_TOKEN=<secreto-staging>
FLEET_API_TOKEN=<secreto-staging>
CHECKOUT_TOKEN_SECRET=<secreto-staging>
PICKUP_QR_SECRET=<secreto-staging>
DELIVERY_QR_SECRET=<secreto-staging>
PIKI_CUSTOMER_SYNC_SECRET=<secreto-staging>
GOOGLE_MAPS_API_KEY=<clave-restringida-a-staging>
```

En staging no configures claves live de Stripe ni webhooks live. Si se prueba pago, usa únicamente claves Stripe test.

## 5. Crear los frontends staging

Para cada app, crea un despliegue staging separado:

- Customer.
- Admin.
- Partner Orders.
- Riders.
- Fleet.
- Support.

Cada uno debe recibir:

```env
VITE_API_URL=https://piki-api-staging.onrender.com
```

Partner Orders utiliza el proxy `/piki-api`; en su Vercel staging el rewrite debe apuntar a `https://piki-api-staging.onrender.com`.

Añade las URLs staging resultantes a `CORS_ORIGINS` del API staging. No añadas dominios públicos de producción.

## 6. Crear datos QA

Ejecuta una vez contra staging, nunca contra producción:

```bash
export NODE_ENV=staging
export PIKI_ENVIRONMENT=staging
export ALLOW_QA_SEED=true
export MONGODB_URI='<URI-STAGING>'
export MONGODB_DB=piki_staging
pnpm run seed:staging:qa
```

Después elimina `ALLOW_QA_SEED` del entorno o configúralo como `false`.

Los datos QA deben tener nombres evidentes:

- `Cliente QA PIKI`.
- `Partner QA Xàtiva`.
- `Rider QA cercano`.
- `Rider QA alternativo`.
- `Admin QA`.
- `Fleet QA`.

Nunca utilices clientes, teléfonos, riders o tarjetas reales para este seed.

## 7. Comprobación antes de probar

Desde una terminal:

```bash
curl -fsS https://piki-api-staging.onrender.com/health
curl -fsS https://piki-api-staging.onrender.com/ready
```

El servicio no está listo si `/ready` no devuelve 200.

Con una cuenta Admin staging, comprueba:

```http
GET /api/v1/admin/operations/health
```

Debe indicar que el sweep automático está sano y que el intervalo es de 5 segundos.

## 8. Cómo probar tú solo el circuito completo

Abre simultáneamente seis pestañas o dispositivos, todos en URLs staging:

1. Customer staging.
2. Partner staging.
3. Rider staging.
4. Admin staging.
5. Fleet staging.
6. Support staging.

Usa una cuenta distinta por rol. No reutilices la sesión de producción.

### Prueba A: entrada del pedido

1. En Customer, selecciona el Partner QA.
2. Añade un producto QA de importe cero o pago Stripe test.
3. Usa una dirección de prueba.
4. Añade una nota de entrega QA si se quiere comprobar ese campo.
5. Confirma el pedido.
6. En Partner, confirma que aparece una tarjeta nueva y una notificación.
7. En Admin, verifica que el pedido tiene `isTestOrder=true`.
8. En Support, verifica que el pedido es visible como caso QA y no como pedido comercial.

### Prueba B: aceptación y preparación

1. En Partner, acepta el pedido.
2. Comprueba que cambia a `accepted`.
3. Pasa a `preparing`.
4. Comprueba que se notifica al rider QA.
5. Marca el pedido como `ready_for_pickup`.
6. Comprueba que Partner, Admin, Rider y Customer reciben el cambio.

### Prueba C: asignación

1. En Fleet, activa el turno del rider QA.
2. Asegúrate de que tiene ubicación staging reciente.
3. En Admin, comprueba la asignación.
4. En Rider, acepta la oferta.
5. Comprueba que el rider más cercano/adecuado recibe el pedido.
6. Confirma que no se crea una segunda asignación por duplicidad SSE.

### Prueba D: llegada y recogida

1. Simula o registra una ubicación cercana al Partner QA.
2. Confirma llegada.
3. Usa el QR/PIN de recogida de staging.
4. Confirma recogida.
5. Intenta confirmar con un QR/PIN incorrecto: debe rechazarse.
6. Comprueba que el Rider deja de ver la dirección del Partner y pasa a la tarjeta del cliente.
7. Comprueba que el teléfono del cliente no se muestra al rider.

### Prueba E: entrega

1. Simula movimiento del rider hacia la dirección QA.
2. Verifica eventos `rider.location_updated` en Customer y Admin.
3. Confirma llegada al cliente.
4. Usa QR/PIN de entrega staging.
5. Finaliza el pedido.
6. Comprueba `delivered` en las seis superficies.
7. Comprueba que el pedido queda excluido de estadísticas e incentivos comerciales.

### Prueba F: reasignación automática

1. Crea o usa un pedido QA asignado al rider QA cercano.
2. No registres llegada al Partner.
3. Espera el límite configurado de 10 minutos o usa la simulación QA protegida.
4. Comprueba que el sweep libera la asignación.
5. Comprueba que el pedido se ofrece al rider QA alternativo.
6. Comprueba el aviso al rider anterior.
7. Comprueba que el historial registra la reasignación.

La prueba se considera correcta si:

```json
{
  "passed": true,
  "pickupReassignMinutes": 10
}
```

## 9. Pruebas de fallo que debes hacer tú solo

- Cerrar Rider y volver a abrirlo.
- Cortar temporalmente la red del Rider.
- Recargar Partner durante un pedido.
- Desconectar y reconectar SSE.
- Enviar QR/PIN incorrecto.
- Intentar utilizar un token staging en producción.
- Intentar utilizar un token producción en staging.
- Intentar abrir un pedido staging desde un frontend producción.
- Reiniciar el servicio Render staging.
- Confirmar que el pedido no se duplica ni pierde su estado.

## 10. Prueba definitiva de aislamiento

Antes de considerar staging válido:

1. Crear un pedido QA staging.
2. Consultar producción y comprobar que no aparece.
3. Consultar las métricas productivas antes y después.
4. Verificar que no aumentan ingresos, entregas, incentivos ni estadísticas.
5. Verificar que ningún push staging llega a dispositivos reales.
6. Verificar que ningún webhook staging apunta a producción.
7. Verificar que los tokens y cookies de staging tienen otro dominio/origen.

## 11. Eliminar staging con un solo comando

El repositorio incluye:

```bash
pnpm run staging:destroy
```

El comando elimina la base `piki_staging` y el servicio Render indicado por `RENDER_SERVICE_ID`. No puede ejecutarse si:

- `PIKI_ENVIRONMENT` no es `staging`.
- `NODE_ENV` es `production`.
- `MONGODB_DB` no es exactamente `piki_staging`.
- Falta `MONGODB_URI`.
- Falta `RENDER_API_TOKEN`.
- Falta `RENDER_SERVICE_ID`.
- No existe `STAGING_DELETE_CONFIRM=DELETE_PIKI_STAGING`.
- No existe `STAGING_DELETE_APPROVED=yes`.

Variables necesarias únicamente en el momento de eliminar:

```env
NODE_ENV=staging
PIKI_ENVIRONMENT=staging
MONGODB_URI=<URI-STAGING>
MONGODB_DB=piki_staging
RENDER_API_TOKEN=<token-render>
RENDER_SERVICE_ID=<id-piki-api-staging>
STAGING_DELETE_CONFIRM=DELETE_PIKI_STAGING
STAGING_DELETE_APPROVED=yes
```

**No ejecutes ese comando hasta haber guardado los logs y resultados de las pruebas.** La eliminación es irreversible.

## 12. Orden diario de trabajo para una sola persona

1. Abrir solo URLs staging.
2. Comprobar `/ready`.
3. Comprobar `operations/health`.
4. Ejecutar una prueba de entrada.
5. Ejecutar una prueba de asignación.
6. Ejecutar una prueba de QR/PIN.
7. Ejecutar una prueba de entrega.
8. Ejecutar una prueba de reasignación.
9. Revisar logs y estados en Admin/Support.
10. Comparar producción antes/después.
11. Apagar o eliminar staging cuando ya no sea necesario.

## Estado actual

El código y el worktree staging ya contienen las protecciones de base y el comando de desmontaje. La activación de infraestructura no se puede completar desde una sesión sin autorización Render ni una URI MongoDB Atlas staging: introducir cualquiera de las dos por la fuerza podría mezclar datos con producción. Esos dos accesos son los únicos bloqueos externos antes de desplegar el servicio aislado.
