# Despliegue del dispatch y aprovisionamiento de Fleet

## 1. Preparar el código

En una máquina de despliegue o en CI:

```bash
git checkout main
git pull --ff-only origin main
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build
```

El parche `dispatch-fix.patch` ya está aplicado en el working copy. Si se parte de un checkout limpio en el que todavía no están los cambios, aplicar:

```bash
git apply dispatch-fix.patch
```

Después repetir `npm run check`, `npm test` y `npm run build`. No se debe ejecutar `git apply` sobre un checkout que ya contenga el parche.

## 2. Desplegar API y worker en Render

El archivo `render.yaml` define dos servicios Docker:

- `piki-api`: servicio web, health check `/health`.
- `piki-dispatch-worker`: worker con `node dist/dispatch-worker.js`.

Con `autoDeploy: true`, el flujo normal es:

1. Crear un commit con el parche y subirlo a `main`.
2. En Render, revisar el deploy generado para `piki-api` y `piki-dispatch-worker`.
3. Esperar a que ambos terminen correctamente.
4. Comprobar `https://api.pikidelivery.com/health`.
5. Confirmar en logs que aparece el worker y que procesa `dispatch_outbox`.

Variables mínimas que deben estar configuradas en Render: `MONGODB_URI`, `MONGODB_DB`, `CORS_ORIGINS`, `CHECKOUT_TOKEN_SECRET`, secretos de Stripe, `GOOGLE_MAPS_API_KEY` si se usa Google Maps y la configuración de correo/push correspondiente. Nunca se copian secretos al repositorio ni al comando de shell guardado en historial.

## 3. Crear zonas y Fleet de Joar

El script es de solo lectura por defecto. El dry-run muestra las 10 zonas con geometría ya versionada:

```text
Xàtiva
La Llosa de Ranes
Novetlè
El Genovés
La Granja de la Costera
Llanera de Ranes
Cerdà
Torrella
Alboi
Bixquert
```

En una shell temporal de Render o en un job protegido, configurar el token de RRHH superadmin sin imprimirlo:

```bash
export PIKI_API_ORIGIN=https://api.pikidelivery.com
export PIKI_ADMIN_TOKEN='TOKEN_BEARER_DE_RRHH'
npm run provision:joar-fleet
```

Revisar el resumen. Para escribir exactamente ese payload:

```bash
PIKI_CONFIRM=CREATE npm run provision:joar-fleet
unset PIKI_ADMIN_TOKEN PIKI_CONFIRM
```

El script crea las zonas que falten, crea `Fleet Joar Daniel Paduany` con 30 riders y los seis tipos de vehículo, crea o enlaza la cuenta `paduanyjoar9@gmail.com`, fija el alcance territorial y revoca las sesiones antiguas mediante el endpoint de autorización. Si el comando devuelve un error, no repetirlo a ciegas: revisar primero qué zonas/Fleet ya existen.

## 4. Rol Finance

La cuenta queda con `roles: ["fleet", "finance"]` y `apiRole: "fleet"`. El panel Fleet continuará emitiendo una sesión Fleet; la autorización financiera efectiva debe seguir limitada a endpoints expresamente permitidos. No se han movido saldos ni se han ejecutado pagos.

Antes de activar transferencias automáticas hay que fijar por escrito: comisión PIKI, comisión Fleet, tratamiento de IVA, momento de reconocimiento del ingreso, reglas de contrarreembolso, aprobación de conciliaciones y separación entre quien opera Fleet y quien aprueba pagos.

## 5. Desplegar el frontend Fleet

El frontend no contiene backend. En Vercel:

1. Confirmar repositorio `rrhhmilchollos-jpg/piki-fleet`, rama `main` y `fleet.pikidelivery.com`.
2. Confirmar `VITE_API_URL=https://api.pikidelivery.com` o dejar el valor por defecto versionado.
3. Ejecutar redeploy con **Clear Build Cache** si se modifica la PWA.
4. Comprobar `https://fleet.pikidelivery.com/release.json`.
5. Iniciar sesión de nuevo después de que la API haya revocado el token anterior.

## 6. Verificación posterior

- Login con `paduanyjoar9@gmail.com` desde Fleet.
- Verificar que `GET /api/v1/auth/employee/me` devuelve rol Fleet y `fleetId` correcto.
- Verificar que solo aparecen riders de la Fleet.
- Crear un turno de prueba y comprobar que el rider aparece como elegible solo con GPS fresco.
- Crear un pedido de staging y confirmar el ciclo `dispatch_outbox`.
- Revisar que ningún pago real, payout o conciliación se haya creado durante la prueba.
