# TODO PIKI Delivery

## Completado

- [x] Rebranding de la portada cliente a PIKI.
- [x] Portada tipo marketplace: categorías, búsqueda, establecimientos, cesta y checkout.
- [x] Catálogo inicial migrado desde la fuente local de Yavoy: Solera Cocina Viva, Taller Verde, Forno Rossi, Nori Club, Brasa Callejera y Miga Dulce.
- [x] DNS de `pikidelivery.com` preparado en Cloudflare con los subdominios principales.
- [x] Dominios principales asociados a los proyectos Vercel cliente, Partners, Admin, Riders y Fleet.
- [x] Documento de algoritmos del ecosistema creado.

## En curso

- [ ] Verificar visualmente la portada PIKI publicada y revisar responsive.
- [ ] Añadir dominios personalizados al servicio API de Render.
- [ ] Crear el proyecto Atlas `PIKI DELIVERY` y el clúster operativo.
- [ ] Conectar `MONGODB_URI` de producción en Render.
- [ ] Ejecutar seed idempotente del catálogo inicial.

## Siguiente fase

- [ ] Separar configuración de producción y staging.
- [ ] Añadir autenticación y roles reales por aplicación.
- [ ] Implementar máquina de estados de pedidos y eventos idempotentes.
- [ ] Implementar cobertura, capacidad, ETA y asignación de riders.
- [ ] Publicar iconos y manifiestos definitivos de Customer, Partner, Rider, Admin y Fleet en sus builds móviles.
- [ ] Configurar pagos, mapas, notificaciones y observabilidad con credenciales de producción.

## Bloqueos externos

- Cloudflare muestra la zona como `pending`: el registrador debe usar `cameron.ns.cloudflare.com` y `khloe.ns.cloudflare.com`.
- MongoDB Atlas requiere crear el proyecto y el clúster desde la sesión autenticada del propietario.
