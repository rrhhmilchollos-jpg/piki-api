# Flujo operativo PRL

La ruta `/formacion-prl?token=...` es un expediente individual, no un certificado oficial automático.

1. Administración pulsa `Solicitar curso PRL` en un rider o partner.
2. La API crea `PrlEnrollment` con token aleatorio almacenado únicamente como hash.
3. El correo contiene una URL personal y avisa de que la plataforma no sustituye al servicio de prevención.
4. El alumno abre los cuatro módulos. Cada módulo consultado queda registrado con fecha, IP y user-agent.
5. El alumno responde cinco preguntas y necesita un 80% o más.
6. Si aprueba, el expediente queda `provider_pending` y el lead se marca como PRL completado internamente.
7. Solo un administrador puede confirmar la referencia del servicio preventivo mediante `/api/v1/admin/prl/enrollments/:id/provider-confirmation`, y solo si `PRL_CERTIFICATE_MODE=provider` y `PRL_CERTIFICATE_ISSUER` están configurados.

## Certificado oficial

PIKI no debe emitir por sí sola un certificado que se presente como acreditación oficial. Antes de activar `provider`, hay que contratar o integrar un servicio de prevención autorizado, acordar el contenido específico del puesto y guardar su referencia externa de validación. Hasta entonces, la aplicación muestra únicamente la constancia interna y el estado pendiente de validación.

## Variables

- `PRL_COURSE_URL`: URL pública de la página.
- `PRL_CERTIFICATE_MODE=provider_pending`: modo seguro inicial.
- `PRL_CERTIFICATE_ISSUER`: denominación legal del proveedor preventivo.
- `PRL_CERTIFICATE_MODE=provider`: activar únicamente después de la integración y validación contractual.
