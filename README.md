# PIKI API

**PIKI API** es el núcleo común para PIKI Delivery, Partners, Riders, Fleet y Control. Es un servicio Node.js/Express preparado para MongoDB Atlas y desplegable como servicio Docker en Render.

## Estado actual

La API implementa comprobaciones de salud, catálogo de restaurantes, alta de partners y resúmenes operativos para los paneles de administración, riders y flotas. El catálogo inicial contiene los seis establecimientos preservados de la web oficial: Solera Cocina Viva, Taller Verde, Forno Rossi, Nori Club, Brasa Callejera y Miga Dulce.

La conexión de Atlas no se guarda en el repositorio. La variable `MONGODB_URI` debe configurarse en el entorno de Render antes de desplegar. Se puede sembrar el catálogo inicial únicamente en un entorno de prueba con `SEED_DEMO_DATA=true`.

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

## Seguridad de configuración

El archivo `.env` no se versiona. Las credenciales se configuran en Render y los clientes solo consumen la API pública a través de HTTPS. Los orígenes autorizados se controlan con `CORS_ORIGINS`.

## Próxima integración

La siguiente iteración introduce autenticación por rol, una máquina de estados transaccional de pedido, pagos y el motor de asignación de riders. El modelo ya contiene índices por categoría, actividad, estado de pedido, identificador público y geoíndices para las posiciones que se habilitarán al activar el servicio de localización.
