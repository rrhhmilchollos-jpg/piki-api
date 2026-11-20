# Recuperación de contraseña Partner: contrato API

## Alcance

Cambios locales de API para el mismo incidente de contraseña. No se han modificado Admin ni Partner, ni `package.json`, configuración, roles, cuentas o datos reales. No se han usado Git, credenciales, conexiones Mongo, envío de correo ni servicios en vivo. La referencia de HEAD facilitada es `694a958`; no se ha consultado Git.

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

Si los correos no coinciden, no hay asociación, la cuenta no es elegible o hay ambigüedad, devuelve `ready: false`, `employee: null` y bloqueos. No busca otra cuenta fuera de esos límites, no crea nada, no corrige email ni roles. Un restaurante inexistente devuelve igualmente el contrato con el ID solicitado, nombre vacío y bloqueo.

Códigos de bloqueo:

- `RESTAURANT_NOT_FOUND_IN_TENANT`
- `RESTAURANT_CONTACT_EMAIL_REQUIRED`
- `PARTNER_RECOVERY_ACCOUNT_NOT_ELIGIBLE`
- `PARTNER_RECOVERY_ACCOUNT_AMBIGUOUS`

El hash es un SHA-256 determinista de un snapshot de campos autorizados de destino y binding, nunca de contraseñas, hashes de sesiones, tokens ni URLs de recuperación. No constituye un permiso ni una credencial.

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
