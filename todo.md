# TODO PIKI Delivery

## Completado y verificado

- [x] Rebranding de la portada cliente a PIKI.
- [x] Catálogo inicial migrado a la semilla: Solera Cocina Viva, Taller Verde, Forno Rossi, Nori Club, Brasa Callejera y Miga Dulce.
- [x] Máquina de estados de pedidos, control de versión y transiciones con validación de rol.
- [x] Endpoints de catálogo, cobertura geográfica, pedidos, localización de riders y resúmenes operativos.
- [x] API compilada y publicada en GitHub: `piki-api`.
- [x] Frontends Partners, Admin, Riders y Fleet compilados, conectados a `https://piki-api-e0yg.onrender.com` y publicados en GitHub.
- [x] Proyectos Vercel creados y variables `VITE_API_URL` configuradas para Customer, Partners, Admin, Riders y Fleet.
- [x] Dominios personalizados añadidos y verificados dentro de Vercel.
- [x] Repositorios separados creados para API, Customer, Partner, Admin, Rider, Fleet, Web pública, Staging y Docs.
- [x] Documento de algoritmos del ecosistema creado.

## Bloqueos actuales, verificados

- [ ] **MongoDB Atlas:** falta crear el proyecto `PIKI DELIVERY`, el clúster y obtener `MONGODB_URI` desde la cuenta Atlas del propietario. Sin esto `/ready`, catálogo real, cobertura y paneles operativos no pueden funcionar con datos persistentes.
- [ ] **DNS:** `pikidelivery.com` continúa pendiente en Cloudflare; los subdominios no resuelven públicamente. El registrador debe usar `cameron.ns.cloudflare.com` y `khloe.ns.cloudflare.com`.
- [ ] **Vercel:** los despliegues nuevos aparecen `BLOCKED` por la protección SSO del equipo. Hay despliegues anteriores `READY`; los dominios personalizados permanecen asociados y verificados. Hay que ajustar la protección del equipo o desplegar con acceso autorizado.
- [ ] **API custom domain:** `api.pikidelivery.com` requiere que DNS esté activo y asociarlo al servicio Render `piki-api-e0yg`.

## Siguiente ejecución cuando Atlas y DNS estén listos

1. Guardar `MONGODB_URI` como secreto en Render, nunca en Git.
2. Activar `SEED_DEMO_DATA=true` solo durante el primer arranque controlado y volver a desactivarlo después.
3. Comprobar `/ready`, `/api/v1/catalog/restaurants` y `/api/v1/coverage`.
4. Ejecutar el seed idempotente y validar índices geoespaciales.
5. Conectar el API custom domain y actualizar CORS definitivo.
6. Resolver la protección SSO de Vercel y promover los despliegues nuevos.
7. Crear API y datos de staging aislados.
8. Añadir autenticación real, roles, pagos, mapas, notificaciones y observabilidad.

## Importante

No se deben introducir contraseñas, URI de MongoDB ni claves de pagos en repositorios Git, archivos `.env` versionados, logs o chats.

## Sincronización Partners → Customers (19 octubre 2026)

- [ ] Los cambios de carta, precios, disponibilidad, horario y estado del local guardados/publicados por Partners deben llegar a Customers al momento, incluso sin iniciar sesión; no se deben exponer pedidos ni datos privados por el canal público.
- [ ] La lectura del catálogo no debe devolver versiones antiguas desde caché HTTP, Redis o memoria después de un cambio.
- [ ] Reiniciar/desplegar la API no debe reemplazar los menús, imágenes ni estado operativo editados de Mr Rooster por valores fijos de arranque.

## Unidad cocina Owner autorizada — 12 noviembre 2026

- [x] `jobRole=partner` con `partnerRoles=["kitchen"]` concede sólo `orders:read` y `orders:prepare`, nunca `partner_admin` ni `*`; se conserva el fallback legítimo cuando no hay roles operativos explícitos.
- [x] Endpoint Owner específico `/api/v1/admin/partners/kitchen-access`, sin UI nueva ni relajación de gates públicos/comunes: valida sesión humana Owner, tenant activo y membership existente admin/owner, restaurante real del mismo tenant y contacto exacto. Persiste cuenta aprobada por Owner, Partner/subadmin/kitchen, membership y un único restaurantId antes de cualquier primer correo; acepta setup pending/inactive sin aprobar local, carta, compliance ni venta. Horario opcional mediante schema/normalizador existente, sólo en primera configuración pending/inactive, crea únicamente perfil `{openingHours}` cuando es null o cambia sólo el campo anidado cuando existe; no modifica horario en reintento/conflicto ni inventa campos legales, reglas, menú o consentimientos.
- [x] Protege Root y no modifica cuentas existentes conflictivas; reintento exacto devuelve `created=false` sin reenviar credenciales ni duplicar. Transacción y fences de tenant/membership/restaurante, índices únicos y rollback sin correo. Nuevas cuentas no operan pedidos cuando el local permanece inactivo/pendiente o sin carta/compliance válidas; no acceden a otro tenant ni a Xàtiva.
- [x] Entrega código y pruebas offline con DB/email/scopes simulados, check/build, informe, manifiesto relativo, diff patch y payload Root `sendActivation=false`; secuencia crear pendiente → bind → activación Partner 24h con aceptación SMTP del destinatario. Cero producción, login, browser, Stripe/envAPI, commits, push, merge o deploy.

Evidencia local: `src/partnerKitchenAccess.test.ts` (36/36), check TypeScript y build API/worker; informe y logs finales en `/home/ubuntu/piki-audit/kitchen-access-api-fix-20261112.md`. Estas casillas certifican contrato de código offline, no alta de José ni entrega de correo en producción.
