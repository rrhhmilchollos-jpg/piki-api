# Fuentes oficiales de Nominalia

- https://www.nominalia.com/help/email-servidores-de-correo-de-nominalia/
  - SMTP: authsmtp.securemail.pro, puerto 465, SSL, usuario y contraseña de la cuenta.
  - IMAP: pop.securemail.pro, puerto 993, SSL.
  - Webmail: https://webmail.nominalia.com/
- https://www.nominalia.com/help/21-de-febrero-de-2024-actualizacion-de-conexion-del-servicio-de-correo/
  - Confirma authsmtp.securemail.pro:465 y SSL; IMAP:993.
- https://www.nominalia.com/help/email-diferencias-entre-imap-pop-y-recomendaciones-de-uso/?lang=en
  - IMAP almacena/sincroniza carpetas en el servidor y Webmail; los mensajes enviados se sincronizan con todos los dispositivos IMAP.
  - La documentación consultada no describe una API pública de tracking de entrega para el servicio de email estándar; la alternativa disponible es SMTP para aceptación y IMAP/Webmail para carpetas y rebotes.
