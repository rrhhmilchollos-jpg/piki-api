# Recuperación de contraseña Partner: contrato API

## Alcance

Cambios locales de API para el mismo incidente de contraseña. No se han modificado Admin ni Partner, ni `package.json`, configuración, roles, cuentas o datos reales. No se han usado Git, credenciales, conexiones Mongo, envío de correo ni servicios en vivo. La referencia de HEAD facilitada para esta mejora de diagnóstico es `5ec222e`; no se ha consultado Git ni verificado el despliegue.

El contacto mostrado para Alibaba por el usuario es `Shanali1997@icloud.com`; no se asume que sea el correo del `EmployeeAccount`. El destino facilitado es tenant `6ab891dbc9ebf588e74114f2`, restaurante `6acad53e7f55ddba7e05c18a`. La API lee los datos persistidos cuando se invoque posteriormente desde la UI autenticada; estos datos no se han verificado en producción.

## Autenticación y alcance

Ambos endpoints utilizan el `requireOwner()` existente, que resuelve la autenticación y vuelve a comprobar una cuenta persistida, activa, aprobada, de RRHH superadmin. No aceptan el token compartido de Admin sin empleado ni un consentimiento proporcionado por el cliente. El tenant debe enviarse explícitamente incluso para root; no se utiliza `tenantScope()` ni existe alcance global implícito. Un Owner no root solo puede usar el tenant de su sesión.

Se usan los mecanismos de autenticación existentes del Admin, sin extraer bearer de otra página o de almacenamiento para esta operación.

## Paso 1: preview, solo lectura

`GET /api/v1/admin/partner-password-recovery/preview?tenantId=<24hex>&restaurantId=<24hex>`

Respuesta 200 con `Cache-Control: no-store`:

```json
{
  "tenantId": "6ab891dbc9ebf588e74114f2",
  "restaurant": { "id": "6acad53e7f55ddba7e05c18a", "name": "Nombre persistido" },
  "employee": { "id": "<24hex>", "name": "Nombre persistido", "email": "correo-validado@example.test" },
  "ready": true,
  "blockers": [],
  "manifestHash": "<64hex sha256>"
}
```

La API carga únicamente el restaurante con ese ID en ese tenant. Normaliza su campo de contacto `Restaurant.email` mediante trim y minúsculas. Busca `EmployeeAccount` por ese email, ese tenant y asociación persistida a ese restaurante (`restaurantId` o `restaurantIds`). Debe existir una única cuenta elegible: activa, aprobada, Partner y con acceso a la superficie Partner; además, el helper existente `partnerBindingForEmployee` debe validar su binding.

Compatibilidad de lectura BSON: cada rama de asociación usa `$in: [ObjectId(restaurantId), restaurantId]`, con el string 24hex exacto normalizado del destino. `tenantId` sigue siendo exclusivamente el ObjectId exacto. El adaptador de empleados usa `EmployeeAccount.collection.find(filter, { projection: whitelist }).toArray()` para evitar que Mongoose recaste el string del `$in` a ObjectId. La whitelist conserva únicamente los campos previos de recuperación/binding; excluye contraseñas, hashes de sesión, tokens y campos arbitrarios tanto en elegibilidad como en diagnóstico. No hay migración, cambio de binding ni asociación automática. El empleado raw es compatible con el helper de envío existente: este lee campos y revalida el binding, sin métodos de documento; el helper y sus validaciones permanecen intactos.

Si los correos no coinciden, no hay asociación, la cuenta no es elegible o hay ambigüedad, devuelve `ready: false`, `employee: null` y bloqueos. No busca otra cuenta fuera de esos límites, no crea nada, no corrige email ni roles. Un restaurante inexistente devuelve igualmente el contrato con el ID solicitado, nombre vacío y bloqueo.

Códigos de bloqueo:

- `RESTAURANT_NOT_FOUND_IN_TENANT`
- `RESTAURANT_CONTACT_EMAIL_REQUIRED`
- `PARTNER_RECOVERY_ACCOUNT_NOT_ELIGIBLE`
- `PARTNER_RECOVERY_ACCOUNT_AMBIGUOUS`

Se conserva `PARTNER_RECOVERY_ACCOUNT_NOT_ELIGIBLE` como primer bloqueo cuando no hay ninguna cuenta elegible. A continuación se incluyen motivos fijos y deduplicados en el mismo array `blockers`, con el contrato `{ code, message }`; la UI existente puede mostrarlos sin cambios. No se publican IDs, nombres, correos, cantidades ni datos internos de las cuentas rechazadas.

| Código de diagnóstico | Condición comprobada |
| --- | --- |
| `ACCOUNT_INACTIVE` | Una cuenta asociada no tiene `active: true`. |
| `ACCOUNT_NOT_APPROVED` | Una cuenta asociada no tiene `authorizationStatus: approved`. |
| `ACCOUNT_NOT_PARTNER` | Una cuenta asociada no satisface `isPartnerEmployee`. |
| `ACCOUNT_PARTNER_SURFACE_NOT_ALLOWED` | El resolver existente no permite la superficie Partner. |
| `ACCOUNT_NOT_FOUND_IN_TENANT` | No se encuentra ninguna cuenta con el contacto exacto en ese tenant. |
| `ACCOUNT_RESTAURANT_ASSOCIATION_MISSING` | Se encuentra una cuenta con el contacto exacto en ese tenant, pero sin asociación válida al restaurante. |
| `ACCOUNT_AMBIGUOUS_IN_TENANT` | El lookup diagnóstico exacto de contacto y tenant es ambiguo; no se selecciona la primera cuenta. |
| `ACCOUNT_LOOKUP_SCOPE_CONFLICT` | Una fila devuelta por el adaptador no cumple los límites esperados. |
| `ACCOUNT_LOOKUP_CHANGED` | El lookup diagnóstico observa una asociación que no apareció en la consulta principal; indica discrepancia entre consultas, no prueba de concurrencia real. Exige otra vista previa y nunca habilita envío. |
| `ACCOUNT_BINDING_VALIDATION_UNAVAILABLE` | La validación de binding falla sin un código permitido y reconocido por el helper existente. |

La consulta principal de elegibilidad conserva los mismos límites: contacto `Restaurant.email` normalizado, tenant explícito y `$or` de asociación por `restaurantId`/`restaurantIds`, ahora con las dos representaciones BSON exactas indicadas. **Solo si devuelve cero candidatos asociados** se realiza un segundo lookup de solo lectura con exactamente `{ tenantId, email: contactoNormalizado }`. No busca globalmente, no usa otro correo y no introduce `loginEmail` en los schemas estrictos de preview/send. Las cuentas de este segundo lookup nunca pasan al conjunto elegible, ni aunque una asociación aparezca durante esas lecturas. Una cuenta no elegible asociada tampoco dispara el segundo lookup.

Los fallos del binding se filtran primero con `partnerBindingErrorResponse` y después por una whitelist local de códigos de lectura: `PARTNER_TENANT_BINDING_REQUIRED`, `EMPLOYEE_NOT_APPROVED`, `PARTNER_RESTAURANT_ASSIGNMENT_INVALID`, `PARTNER_RESTAURANT_NOT_ASSIGNED`, `PARTNER_TENANT_NOT_ACTIVE`, `PARTNER_RESTAURANT_NOT_FOUND_IN_TENANT`, `PARTNER_RESTAURANT_SETUP_INVALID`, `PARTNER_MEMBERSHIP_BINDING_REQUIRED`, `PARTNER_ROLES_REQUIRED`, `PARTNER_MEMBERSHIP_SCOPE_CONFLICT`, `KITCHEN_ACCOUNT_BINDING_CONFLICT`, `KITCHEN_TENANT_NOT_ACTIVE`, `KITCHEN_RESTAURANT_NOT_FOUND_IN_TENANT`, `KITCHEN_RESTAURANT_SETUP_INVALID`, `KITCHEN_RESTAURANT_CONTACT_CONFLICT` y `KITCHEN_MEMBERSHIP_CONFLICT`. Cada uno tiene un mensaje fijo local. Códigos arbitrarios, errores sin la clase reconocida, conflictos de escritura y mensajes internos quedan excluidos y usan el fallback seguro.

El hash es un SHA-256 determinista de un snapshot de campos autorizados de destino y binding, nunca de contraseñas, hashes de sesiones, tokens ni URLs de recuperación. Ahora incluye también los códigos seguros de rechazo de candidatos y el snapshot interno de campos ya autorizados de las cuentas del lookup diagnóstico. Los cambios en esos campos invalidan la confirmación anterior aunque el motivo visible no cambie. Los campos secretos y arbitrarios siguen excluidos. No constituye un permiso ni una credencial.

## Paso 2: confirmación y envío por clic explícito

La UI debe mostrar el destinatario devuelto, deshabilitar el botón si `ready` es falso y exigir confirmación antes de llamar:

`POST /api/v1/admin/partner-password-recovery/send`

```json
{
  "tenantId": "6ab891dbc9ebf588e74114f2",
  "restaurantId": "6acad53e7f55ddba7e05c18a",
  "employeeId": "<employee.id devuelto por preview>",
  "manifestHash": "<manifestHash devuelto por preview>",
  "confirmation": "SEND_PARTNER_PASSWORD_RECOVERY"
}
```

El cuerpo es estricto; no acepta email, password, token, resetUrl, consent ni campos adicionales. Recalcula el snapshot y hash actual, exige el mismo empleado y revalida el binding inmediatamente antes de invocar el helper existente `sendEmployeePasswordLink(employee, 'partner', 'recovery')`. No mantiene ninguna transacción abierta durante el correo.

Respuesta 200 únicamente si el helper confirma `delivery.sent === true`:

```json
{
  "sent": true,
  "tenantId": "6ab891dbc9ebf588e74114f2",
  "restaurantId": "6acad53e7f55ddba7e05c18a",
  "employeeId": "<24hex>",
  "recipient": "correo-validado@example.test",
  "expiresInMinutes": 30
}
```

Errores relevantes:

| HTTP | Código | Comportamiento UI |
| --- | --- | --- |
| 400 | `INVALID_PARTNER_RECOVERY_TARGET` / `INVALID_PARTNER_RECOVERY_CONFIRMATION` | Corregir destino o confirmación. |
| 401/403/428 | Guard Owner existente | Reautenticar o mostrar la restricción. |
| 403 | `PARTNER_RECOVERY_TENANT_FORBIDDEN` | No cambiar automáticamente de tenant. |
| 409 | `PARTNER_RECOVERY_PREVIEW_CHANGED` | Recargar preview y pedir nueva confirmación; nunca reenviar automáticamente. |
| 409 | `PARTNER_RECOVERY_BLOCKED` | Mostrar los blockers, sin sugerir cambios automáticos de roles/correo. |
| 429 | `RATE_LIMITED` | Respetar `Retry-After` y `retryAfterSeconds`. |
| 503 | `PARTNER_RECOVERY_UNAVAILABLE` / `PARTNER_RECOVERY_DELIVERY_UNAVAILABLE` | No afirmar que se envió; ofrecer reintento explícito posterior. |

El límite es de 3 solicitudes por 15 minutos, por actor persistido y destino tenant/restaurante. Las claves no incluyen bearer, emails, valores arbitrarios de cabeceras ni tokens. Usa contadores compartidos existentes con fallback local acotado. No hay garantía global multiinstancia si los contadores compartidos no están disponibles.

La aceptación por el proveedor no garantiza llegada a la bandeja de entrada. Un fallo de auditoría posterior no convierte un correo ya aceptado en `sent: false`. La auditoría usa `GovernanceAuditEvent` con IDs de destino, actor y resultado, sin secretos.

Se conserva exactamente la política del helper existente: invalida enlaces anteriores sin usarlos y emite otro, también si después no se puede confirmar la entrega. No se borran correos ni se cambia la contraseña durante el reenvío. No se introduce reintento automático ni un enlace alternativo.

## Confirmación de contraseña corregida

`POST /api/v1/auth/employee/password-reset/confirm` conserva el contrato de entrada y el éxito `{ "changed": true }`. Se ejecutan dentro de la misma transacción Mongo:

1. Leer y validar token no utilizado, caducidad, superficie almacenada si existe y cuenta activa/aprobada con el correo vinculado.
2. Comprobar permiso para la superficie y el binding mediante `partnerBindingForEmployee` intacto; sus lecturas usan la misma sesión y se serializan.
3. Reclamar el token por CAS (`_id`, `employeeId`, `tokenHash`, `usedAt: null`, caducidad).
4. Guardar contraseña, fecha de cambio y limpiar el hash de sesión heredado.
5. Ejecutar `revokeEmployeeSessions(employeeId, session)`.
6. Confirmar la transacción.

Los fallos de validación no llegan al claim. Fallos de save, revocación o commit abortan la operación sin una alternativa no transaccional. Sin soporte de transacciones o ante error de infraestructura, responde 503 `PASSWORD_RESET_UNAVAILABLE` con mensaje público no sensible. Mongo debe ser replica set o clúster compatible; no se ha comprobado su topología real.

Los nuevos enlaces almacenan su superficie, evitando que se confirmen desde otra aplicación. Los enlaces históricos sin ese campo siguen exigiendo las comprobaciones de superficie de la cuenta y binding; no se inventa una superficie histórica. Ante un resultado de commit desconocido por fallo de red, se informa de indisponibilidad y no se promete reutilización del enlace.

No se devuelve ni registra token, URL de reset, `reset.tokenHash` o contraseña. Se eliminó del log de rechazo del proveedor HTTP la clave de idempotencia que podía contener indirectamente el hash del token.

## Validación local

Ejecutar únicamente con dependencias ya presentes, sin instalaciones ni arranque de producción:

```sh
node scripts/offline-validation.mjs check
node scripts/offline-validation.mjs test
./node_modules/esbuild/bin/esbuild src/server.ts src/dispatch-worker.ts --platform=node --packages=external --bundle --format=esm --outdir=/tmp/piki-password-recovery-build
```

El runner de pruebas bloquea sockets, HTTP, fetch y las operaciones reales de Mongo, y no carga archivos dotenv. Las pruebas nuevas cubren éxito, expiración, enlace inválido/utilizado, superficies equivocadas, binding inválido, save/revoke/commit fallidos, falta de transacciones, concurrencia con un único ganador y rollback. También comprueban el handler/adaptador real extraído de AST, guard Owner persistido, alcance exacto, contacto distinto del email EmployeeAccount, ambigüedad, hash obsoleto, contrato estricto, rechazo de entrega, auditoría y rate limit. No sustituyen una prueba contra un replica set real ni una comprobación real de entrega.

## Archivos del cambio

Nuevos: `src/employeePasswordResetConfirm.ts`, `src/employeePasswordResetConfirm.test.ts`, `src/partnerPasswordRecovery.ts`, `src/partnerPasswordRecovery.test.ts`, `src/employeePasswordRecoveryMailLogs.test.ts`, este documento.

Modificados: `src/server.ts`, `src/passwordReset.ts`, `src/employeeSessions.ts`, `src/allPartnerAccess.test.ts`, `src/corporateEmail.ts` (solo log de rechazo sin clave de idempotencia).

`src/employeePartnerBinding.ts`, controles de Partner, configuración y `package.json` permanecen sin modificar por esta tarea.

## Resultado de la validación de esta implementación

- `node scripts/offline-validation.mjs check`: aprobado, sin diagnósticos.
- Suite específica de este incidente: 132 pruebas aprobadas, 0 fallos.
- Suite completa final: 1.635 pruebas contabilizadas, 1.634 aprobadas, 1 omitida, 0 fallos.
- Build local final de API y worker con esbuild: aprobado. Artefactos en `/tmp/piki-password-recovery-build/`; no se ha sobrescrito `dist/` ni instalado dependencias.

Logs locales: `/tmp/piki-recovery-check.log`, `/tmp/piki-recovery-targeted.log`, `/tmp/piki-recovery-full-tests.log`, `/tmp/piki-recovery-build.log`. Los resultados se obtuvieron sin env real, sin conexiones de red/Mongo y sin correo real.

## Validación de la mejora de diagnóstico (20 de noviembre de 2026)

Esta mejora modifica únicamente `src/partnerPasswordRecovery.ts`, `src/partnerPasswordRecovery.test.ts` y este documento. No cambia el send/helper, guard Owner, permisos, schemas de entrada, wiring del servidor, paquetes ni configuración. No se han consultado Git, el despliegue indicado, Mongo o SMTP, ni leído secretos. El único correo de destino utilizado en fixtures y filtros es el contacto confirmado `shanali1997@icloud.com`; las cuentas sintéticas de otro correo/tenant se usan exclusivamente para verificar su rechazo, nunca como destinatarios alternativos.

Validaciones locales con dependencias existentes y entorno limpio:

- Check TypeScript offline: aprobado, sin diagnósticos.
- Suite de recuperación: 111 pruebas, 111 aprobadas y 0 fallos.
- Batería focalizada ampliada: 228 pruebas, 228 aprobadas y 0 fallos (`partnerPasswordRecovery`, `employeePasswordResetConfirm`, `employeePasswordResetRequest`, `employeePasswordRecoveryMailLogs`, `partnerKitchenAccess`, `allPartnerAccess`).
- Suite completa: 1.719 pruebas, 1.718 aprobadas, 1 omitida y 0 fallos.
- Build temporal de API y worker: aprobado, en `/tmp/piki-recovery-diagnostics-build.59yo4B/`, sin modificar `dist/`.

Check y pruebas focalizadas usan además `scripts/partner-offline-guard.mjs`, que bloquea lecturas de secretos, red y arranque de aplicación. La suite completa usa el runner `scripts/offline-validation.mjs` con su entorno de pruebas sanitizado, red y operaciones reales Mongo bloqueadas, `PIKI_NO_LISTEN=true` y dotenv dirigido a `/dev/null`; sus integraciones existentes solo importan el servidor en modo offline.

Logs: `/tmp/piki-recovery-diagnostics-check.log`, `/tmp/piki-recovery-diagnostics-targeted.log`, `/tmp/piki-recovery-diagnostics-related.log`, `/tmp/piki-recovery-diagnostics-full.log` y `/tmp/piki-recovery-diagnostics-build.log`.

La causa real persistida del destino aún no se puede afirmar: esta tarea no ha leído producción. El siguiente preview autenticado podrá mostrar el motivo seguro exacto que observen sus consultas, además del código agregado existente, sin modificar ni habilitar automáticamente ninguna cuenta.

## Validación de compatibilidad BSON (20 de noviembre de 2026)

Corrección limitada a `src/partnerPasswordRecovery.ts`, su test, el adaptador de recuperación en `src/server.ts` y este documento. Contratos HTTP, schemas estrictos, guard Owner, rate limit, hash/confirmación, helper de envío y validaciones de rol/tenant/membresía/restaurante se mantienen. `package.json`, modelos y helpers de binding no se modifican. No se accedió a red, Mongo, SMTP, secretos, otros repositorios ni producción; no se realizaron escrituras Git, push o deploy. Como excepción de procedimiento, al inicio se ejecutaron consultas Git de solo lectura de estado/HEAD, pese a la restricción de no usar Git; no se volvió a utilizar.

Se añadieron 12 pruebas offline: igualdad BSON sin coerción para asociación escalar/array string u ObjectId y mezcla; exclusión de otro tenant/email/restaurante y de tenant string; validación de binding intacta; adaptador real compilado desde AST con proyección de inclusión y sin Mongoose `find`; y helper real compatible con empleado raw, con reset/correo exclusivamente simulados. No equivalen a una comprobación del BSON persistido real ni confirman la causa del hallazgo live facilitado.

- Check TypeScript offline: aprobado, sin diagnósticos.
- Suite específica: **123 pruebas aprobadas, 0 fallos**.
- Suite focalizada ampliada: **240 pruebas aprobadas, 0 fallos**.
- Suite completa: **1.731 pruebas, 1.730 aprobadas, 1 omitida, 0 fallos**.
- Build API/worker: aprobado en `/tmp/piki-recovery-bson-build.tkFZWg/`; no se modifica `dist/` ni se instalan paquetes.

Check y suites focalizadas: entorno limpio `env -i PATH="$PATH" HOME="$HOME"`, `node --import ./scripts/partner-offline-guard.mjs scripts/offline-validation.mjs check|test ...`. Suite completa: mismo entorno limpio y runner offline existente, con red/operaciones reales Mongo bloqueadas, sin listener y dotenv dirigido a `/dev/null`. Build con esbuild ya instalado, entorno limpio y salida temporal.

Logs: `/tmp/piki-recovery-bson-check.log`, `/tmp/piki-recovery-bson-targeted.log`, `/tmp/piki-recovery-bson-related.log`, `/tmp/piki-recovery-bson-full.log`, `/tmp/piki-recovery-bson-build.log`.
