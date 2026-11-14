# Informe de estado y checklist GO-LIVE — PIKI Delivery

**Fecha de comprobación:** 14 de noviembre de 2026  
**Repositorio auditado:** `rrhhmilchollos-jpg/piki-api`  
**Dominio público:** `https://pikidelivery.com`  
**API pública:** `https://api.pikidelivery.com`

## Resumen ejecutivo

El ecosistema tiene una base técnica amplia y el backend está respondiendo en producción. La API pública devuelve HTTP 200 en `/health` y, tras el push, Render ya sirve el commit `434119f3800b618d5ef5755f64f508fd2e6fe688`. Los cambios de avatar administrativo y la unificación de comisiones ya están publicados en el API.

La API no está desplegada en Vercel. La respuesta pública de `api.pikidelivery.com` incluye `x-render-origin-server: Render`, y el `render.yaml` del repositorio declara dos servicios Render: `piki-api` y `piki-dispatch-worker`. Vercel sí sirve los frontends y dominios como `pikidelivery.com`, `admin.pikidelivery.com`, `partners.pikidelivery.com` y `rider.pikidelivery.com`.

El dispatch tiene una cobertura automatizada sólida: **166 pruebas de dispatch pasan**, incluyendo ranking, elegibilidad por vehículo, outbox, leases, reintentos, reservas CAS, sesiones reales, GPS, aceptación de ofertas y protección contra carreras concurrentes. En la ejecución combinada más reciente pasan **195/195 pruebas**: 166 de dispatch y 29 de marketplace/catalogo/settlements. No se ha ejecutado la prueba E2E real contra producción porque requiere `PIKI_E2E_ADMIN_TOKEN` y crea temporalmente un pedido QA; el script está preparado para crearlo, esperar la asignación y eliminarlo al terminar.

## Evidencia de producción

### API

| Comprobación | Resultado |
|---|---|
| `GET https://api.pikidelivery.com/health` | HTTP 200 |
| Estado declarado | `ok` |
| Commit servido | `434119f3800b618d5ef5755f64f508fd2e6fe688` |
| Proveedor observado | Render detrás de Cloudflare |
| `GET /api/v1/health` | HTTP 404; el endpoint canónico es `/health` |

Cabecera observada:

```text
x-render-origin-server: Render
server: cloudflare
```

### Frontends

Los siguientes dominios responden HTTP 200 y están servidos por Vercel:

- `https://pikidelivery.com`
- `https://www.pikidelivery.com`
- `https://admin.pikidelivery.com`
- `https://partners.pikidelivery.com`
- `https://rider.pikidelivery.com`
- `https://fleet.pikidelivery.com`

La cuenta Vercel consultada no devolvió proyectos accesibles mediante la integración disponible, por lo que no se pudo obtener desde MCP el ID, commit o historial de despliegues de esos frontends. Eso no cambia la evidencia DNS/HTTP: los frontends están vivos en Vercel, pero la API está en Render.

La integración Render no pudo listar el workspace por falta de autorización. Por ello se verificó producción mediante HTTP y configuración versionada, pero no se pudo confirmar desde la consola Render el estado interno del worker ni el último deploy del servicio.

## Despliegue de los últimos cambios

### Estado local

El repositorio local contiene cambios sin commit en:

- `src/server.ts`
- `src/marketplaceAccounting.ts`
- `src/settlements.ts`
- `src/customerCatalogPolicy.ts`
- `src/customerCatalogPolicy.test.ts`
- `src/catalogSafety.integration.test.ts`
- `scripts/import-xativa-local-catalog.ts`

También existe un QR corregido en `artifacts/piki-qr-pikidelivery-com.png`.

### Conclusión

**El API ya está actualizado en producción.** Render recogió el push y `/health` confirma el commit nuevo. Quedan por verificar operativamente:

- Logs internos y estado del worker `piki-dispatch-worker`.
- E2E QA real, pendiente del token `PIKI_E2E_ADMIN_TOKEN`.
- Secretos live y configuración de payout, pendiente de acceso Render y decisiones de negocio.

Antes de GO-LIVE hay que hacer commit, revisión y push al repositorio conectado al servicio Render, esperar al auto-deploy y volver a comprobar `/health` y el commit servido.

La verificación local más reciente también pasa `npm run check` y `npm run build` sin errores.

## Prueba de integración del dispatch

### Prueba realizada

Comando ejecutado:

```bash
node scripts/offline-validation.mjs test \
  src/dispatch.test.ts \
  src/dispatchOutbox.test.ts \
  src/dispatchFixes.integration.test.ts \
  src/dispatchOnline.integration.test.ts
```

Resultado:

```text
166 tests
166 pass
0 fail
```

La cobertura incluye:

- Selección del rider elegible más cercano.
- Ranking por distancia, ETA, preparación, carga, fiabilidad, rating y prioridad.
- Reglas duras de vehículos ligeros por distancia y municipio.
- Exclusión de pedidos cancelados, no pagados, offline, caducados o incompatibles.
- Outbox idempotente.
- Lease de worker y recuperación de leases caducados.
- Backoff de reintentos.
- Reservas de rider y control de capacidad.
- CAS de pedido y rider frente a carreras concurrentes.
- Sesión real, tenant, GPS fresco y estado operativo.
- Creación de oferta, publicación realtime, reintento y aceptación.
- Liberación correcta ante pago refundido, desconexión o revocación.

### Prueba E2E real disponible

El repositorio contiene `scripts/e2e-order-flow.mjs`, que ejecuta este flujo QA:

1. Comprobar salud de la API.
2. Crear pedido QA aislado.
3. Encolarlo en `dispatch_outbox`.
4. Esperar hasta 30 segundos a la asignación del worker.
5. Confirmar `riderId` y estado coherente.
6. Eliminar pedido y rider QA.

Se ejecutó el modo de planificación y los seis pasos están definidos. No se ejecutó `--apply` porque requiere un token administrativo no disponible en esta sesión y porque crearía efectos temporales en producción.

Comando para el propietario del entorno:

```bash
PIKI_E2E_ADMIN_TOKEN='<token-admin-qa>' \\
PIKI_API_ORIGIN='https://api.pikidelivery.com' \\
node scripts/e2e-order-flow.mjs --apply
```

Debe realizarse preferentemente contra un entorno staging o con un token específicamente limitado al escenario QA.

## Estado de APIs y componentes

| Área | Estado | Evidencia / pendiente |
|---|---|---|
| API HTTP principal | Operativa | `/health` HTTP 200 |
| Autenticación de empleados | Implementada | Sesiones persistidas, roles y tenant |
| Customer API / compatibilidad tRPC | Implementada | Flujos de catálogo, quote, checkout y sync cubiertos por tests |
| Partner API | Implementada | Onboarding, menú, horarios, estados y acceso operativo |
| Rider API | Implementada | Ofertas, aceptación, GPS, sesiones y estados |
| Fleet API | Implementada | Flotas, zonas, riders y planificación |
| Admin API | Implementada | Gestión de empleados, partners, riders, payouts y QA |
| Fotos propias de empleados | Operativa | Validación PNG/JPEG/WebP y pruebas verdes |
| Foto de empleado por Admin | Implementada localmente | Pendiente de desplegar |
| Comisiones marketplace | Implementadas localmente | 18% unificado pendiente de desplegar |
| Ledger de marketplace | Implementado | Valida equilibrio e idempotencia |
| Stripe/webhooks | Implementado | Requiere confirmar secretos, endpoints live y eventos en producción |
| Bizum manual | Implementado | Requiere procedimiento financiero operativo |
| Dispatch ranking | Implementado | 166 pruebas verdes |
| Dispatch outbox | Implementado | Worker Render declarado en `render.yaml` |
| Dispatch worker producción | No verificado internamente | Requiere acceso Render y logs/health del worker |
| Realtime/SSE | Implementado | Hay relay local y Change Streams; probar con Mongo real |
| Routing/geocoding | Implementado con degradación | Requiere clave Google Maps y monitorización de errores |
| Email corporativo | Configurado por variables | Confirmar SMTP/Resend y entrega real |
| Push notifications | Implementado | Confirmar claves VAPID/Firebase y prueba por superficie |
| Google Business Profile | Implementado opcional | Está desactivado por defecto según configuración |
| Signaturit | Integración preparada | Confirmar token, modo y webhook si se usará en GO-LIVE |
| QR y dominios | Dominio correcto operativo | QR antiguo apunta a dominio inexistente; sustituir o registrar alias |

## Checklist GO-LIVE

### Bloqueadores antes de publicar

- [ ] Crear commit de los cambios locales.
- [x] Revisar el diff final y ejecutar las pruebas locales de dispatch, marketplace y catálogo: 195/195 correctas.
- [x] Push al repositorio conectado a Render.
- [x] Esperar auto-deploy de `piki-api`.
- [x] Verificar que `/health` devuelve el nuevo commit `434119f3800b618d5ef5755f64f508fd2e6fe688`.
- [ ] Verificar el deploy del servicio `piki-dispatch-worker`.
- [ ] Revisar logs del worker durante una ventana de tráfico controlado.
- [ ] Ejecutar `scripts/e2e-order-flow.mjs --apply` en staging o QA.
- [ ] Confirmar que el pedido QA se elimina y no deja rider, oferta ni outbox huérfanos.
- [ ] Ejecutar un pedido real controlado con partner y rider autorizados.
- [ ] Confirmar webhook Stripe live y redelivery idempotente.
- [ ] Confirmar MongoDB Atlas, índices, backups y usuario de producción.
- [ ] Confirmar `CORS_ORIGINS` de todos los frontends reales.
- [ ] Confirmar secretos de producción sin valores de staging.
- [ ] Confirmar SMTP/Resend y recepción en soporte, RRHH, finanzas y operaciones.
- [ ] Confirmar Google Maps/routing y plan de contingencia si el proveedor falla.
- [ ] Confirmar VAPID/Firebase y notificaciones en Customer, Partner, Rider y Admin.
- [ ] Registrar `pickidelivery.com` si se quiere conservar el QR impreso; de lo contrario, reemplazar los QR.

### Revisión de negocio y operaciones

- [ ] Firmar y publicar la tabla de comisiones del partner.
- [ ] Comunicar que el defecto de comisión es 18% y documentar excepciones negociadas.
- [ ] Definir payout de riders; `render.yaml` declara actualmente modo `founder_partner` y payout configurado a 0.
- [ ] Definir tiempos máximos de preparación, aceptación, recogida y entrega.
- [ ] Definir quién atiende cancelaciones, reembolsos, efectivo y reclamaciones.
- [ ] Validar cobertura geográfica inicial y municipios realmente habilitados.
- [ ] Validar protección de datos, contratos de partners, riders y empleados.
- [ ] Activar monitorización y alertas para 5xx, outbox, dead letters, Stripe y Mongo.
- [ ] Preparar procedimiento de rollback del API y del worker.

## Lectura competitiva de la publicidad de Glovo

La captura muestra una campaña de captación B2B para restaurantes con una propuesta muy directa:

- Beneficio principal: aumentar ingresos.
- Fricción baja: tres pasos visibles — registrarse, subir carta y recibir pedidos.
- CTA claro: “Regístrate”.
- Prueba social visible mediante interacciones del anuncio.
- Landing específica (`sell.glovoapp.com`) y formulario dedicado.

No hay evidencia en la captura de que Glovo haya visto Piki. Es una pauta normal de adquisición de partners y probablemente el algoritmo publicitario la muestra por intereses, ubicación o actividad relacionada con restauración y delivery.

La respuesta competitiva recomendable no es copiar creatividades ni atacar a Glovo, sino ofrecer una propuesta local y medible:

1. **Comisión transparente y moderada:** destacar el 18% estándar y publicar ejemplos de liquidación.
2. **Alta rápida:** promesa verificable de alta, carta y primera venta en un plazo concreto.
3. **Atención local:** soporte humano en Xàtiva y expansión por zonas, con teléfono y WhatsApp visibles.
4. **Control para el partner:** propiedad de sus precios, horarios, disponibilidad y datos de operación.
5. **Riders mejor tratados:** reglas claras, pago y cobertura explicados sin promesas que el sistema no pueda cumplir.
6. **Diferenciación navideña:** campaña “Esta Navidad empieza en Piki”, con alta de partners y riders por provincia.
7. **Densidad local antes que expansión vacía:** dominar una ciudad con tiempos consistentes antes de comprar alcance nacional.
8. **Publicidad por vertical:** anuncios separados para restaurantes, comercios locales, riders y clientes.

Mensaje recomendado para partners:

> “Vende online sin comisiones abusivas. Alta sencilla, soporte local y liquidaciones claras. Esta Navidad empieza en Piki.”

El claim “nuevo rey del delivery en España” puede utilizarse como ambición interna o tono de campaña, pero no debe presentarse como un hecho objetivo ni acompañarse de comparativas no verificadas.

## Veredicto

**Estado técnico:** preparado para una fase de staging/QA avanzada, no todavía para declarar GO-LIVE completo.  
**Motivo principal:** los últimos cambios no están desplegados y el dispatch E2E real de producción no ha sido ejecutado.  
**Prioridad inmediata:** publicar el commit, comprobar el worker Render, ejecutar el flujo QA E2E y cerrar secretos, pagos, notificaciones, DNS del QR y procedimientos operativos.
