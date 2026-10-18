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
