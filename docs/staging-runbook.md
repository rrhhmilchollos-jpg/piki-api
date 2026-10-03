# PIKI staging: despliegue y pruebas E2E seguras

## Aislamiento obligatorio

| Componente | Producción | Staging |
|---|---|---|
| Rama API | `main` | `staging` |
| Servicio Render | `piki-api` | `piki-api-staging` |
| Base de datos | `piki` | `piki_staging` |
| Señal de entorno | no definida | `PIKI_ENVIRONMENT=staging` |
| Pedidos de prueba | bloqueados | solo con `PIKI_ALLOW_TEST_ORDERS=true` |

> **Nunca** se reutiliza la base `piki` de producción. El URI del servicio staging debe apuntar a una base o clúster aislado y `MONGODB_DB` debe ser `piki_staging`.

## Render

1. Crear `piki-api-staging` en Frankfurt, conectado a `rrhhmilchollos-jpg/piki-api`, rama `staging` y `Dockerfile`.
2. Usar el plan **Starter**: evita la suspensión del proceso y permite que el sweep de 5 segundos, SSE y el relay realtime funcionen durante las pruebas.
3. Cargar las variables de `.env.staging.example` como secretos distintos de producción. La configuración declarativa está en `render.staging.yaml`.
4. Configurar el health check `/ready`. Confirmar que `/health` y `/ready` devuelven 200.

## Frontends de preview

Crear ramas `staging` de Customer, Partner, Rider, Admin y Fleet. En los despliegues Vercel Preview, definir:

```text
VITE_API_URL=https://<url-de-piki-api-staging>
```

Añadir las URLs exactas de los previews al `CORS_ORIGINS` del staging. No cambiar `VITE_API_URL` de producción.

## Prueba E2E de reasignación

Con una sesión de Admin **en staging** (o con el token técnico `ADMIN_API_TOKEN` del propio staging), ejecutar:

```http
POST /api/v1/admin/qa/reassignment-simulation
```

La ruta solo existe cuando `PIKI_ENVIRONMENT=staging` y `PIKI_ALLOW_TEST_ORDERS=true`. Crea dos riders QA y un pedido `isTestOrder=true` cuyo plazo de llegada ya venció. La prueba pasa únicamente si:

1. el sweep libera al rider asignado que no llegó al Partner;
2. el algoritmo ofrece el pedido al rider QA más cercano;
3. la respuesta contiene `passed: true` y `pickupReassignMinutes: 10`.

Después, consultar `GET /api/v1/admin/operations/health` con Admin de staging: `automaticDispatchSweep.healthy` debe ser `true` y `intervalSeconds` debe ser `5`.

## Criterios de salida

- Customer crea pedido de prueba y Partner lo recibe por SSE.
- Rider QA recibe la oferta, confirma llegada cerca del Partner y confirma recogida.
- Customer de staging recibe `rider.location_updated` y el mapa se actualiza.
- La simulación de reasignación retorna `passed: true`.
- Ningún pedido, Rider o evento de prueba aparece en producción.
