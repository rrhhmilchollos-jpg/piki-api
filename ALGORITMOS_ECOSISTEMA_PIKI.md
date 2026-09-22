# Algoritmos del ecosistema PIKI Delivery

**Versión:** baseline de lanzamiento para una primera ciudad y evolución posterior.  
**Alcance:** web/app de clientes, Partners, Riders, Admin, Fleet, API central y web pública.

## Principios comunes

PIKI debe empezar con reglas deterministas, explicables y auditables. Cada decisión operativa debe guardar sus entradas, versión de la regla, candidatos considerados, exclusiones, resultado y motivo. La inteligencia predictiva se incorporará únicamente cuando pueda demostrar una mejora medible frente al baseline.

La unidad de tiempo del sistema será el evento de negocio: pedido creado, comercio aceptado, pedido preparado, rider asignado, recogida confirmada, entrega completada, cancelación o reembolso. Los eventos serán idempotentes mediante una clave de operación y se conservarán para reconstruir el estado.

## 1. PIKI Customer y marketplace

### Selección de cobertura

1. Geocodificar la dirección del cliente.
2. Comprobar que el punto pertenece a una zona operativa activa.
3. Obtener comercios cuyo polígono de reparto contiene el punto.
4. Excluir comercios cerrados, pausados, sin capacidad o fuera del radio operativo.
5. Mostrar la razón de indisponibilidad cuando el usuario la solicite.

**Baseline:** punto dentro de polígono más reglas de horario y capacidad.  
**Evolución:** zonas dinámicas y predicción de demanda por celda geográfica.

### Ranking del catálogo

Para cada comercio elegible se calcula una puntuación explicable:

`score = 0,30 calidad + 0,22 tiempo_normalizado + 0,18 proximidad + 0,12 disponibilidad + 0,10 afinidad_categoria + 0,08 diversidad`

La calidad usa una media bayesiana para que una tienda nueva no supere artificialmente a otra con muchas opiniones. Las promociones se etiquetan y nunca sustituyen silenciosamente la calidad. Se aplica una restricción de diversidad para no mostrar siempre los mismos comercios.

### Cesta, precio y checkout

El servidor recalcula precios, gastos, impuestos y promociones; nunca acepta el total calculado únicamente por el cliente. La cesta se vincula a un comercio por defecto. Se usa idempotencia para evitar pedidos duplicados al repetir el pago. La reserva de precio caduca y debe recalcularse si cambia el menú.

### ETA para el cliente

`ETA = preparación_p50_comercio + llegada_rider_p50 + viaje_destino_p80 + margen_operativo`

Se muestra un intervalo conservador, no una promesa exacta. Si faltan datos, se utiliza una mediana por categoría y franja horaria con margen mayor.

**Métricas:** conversión de catálogo a cesta, conversión a pedido, error absoluto de ETA, cancelaciones antes de aceptación, repetición a 30 días.

## 2. PIKI Partners

### Disponibilidad y capacidad

El comercio se considera disponible si está dentro del horario, activo manualmente, con menú publicable y capacidad de preparación disponible. La capacidad inicial es un límite por franja y una cola de pedidos abiertos.

`capacidad_restante = limite_franja - pedidos_en_preparacion - reservas_activas`

Cuando la capacidad llega al umbral de seguridad, se amplía la ETA o se pausa temporalmente la recepción. El comercio puede sobrescribir el estado, pero queda auditado.

### Tiempo de preparación

Se calcula con una mediana móvil por comercio, tipo de pedido y franja. El sistema añade un percentil alto cuando aumenta la cola. Los cambios extremos requieren confirmación del comercio.

### Publicación del catálogo

Cada modificación de menú se valida contra esquema: nombre, precio positivo, alérgenos, disponibilidad, categoría e imagen. Se usa revisión por estado: borrador, enviado, aprobado, publicado y archivado. Una edición no debe modificar pedidos históricos.

**Métricas:** aceptación del comercio, precisión de preparación, porcentaje de pausas, pedidos rechazados, disponibilidad efectiva y ventas por franja.

## 3. PIKI Riders

### Elegibilidad

Un rider es elegible si está activo, tiene GPS reciente, se encuentra en zona compatible, tiene vehículo válido, capacidad disponible y no está bloqueado por una incidencia. La ubicación exacta se retiene durante el periodo mínimo necesario.

### Asignación inicial

Para cada candidato elegible se calcula:

`coste = 0,35 llegada_recogida + 0,25 retraso_cliente + 0,15 carga_actual + 0,10 ajuste_zona + 0,10 fiabilidad + 0,05 prioridad_servicio`

Se filtran primero restricciones duras y se ordena después por coste. La reserva del rider se realiza de forma atómica con expiración. Si no acepta dentro del tiempo definido, la reserva se libera y se reintenta sin crear dos asignaciones simultáneas.

### Navegación y prueba de entrega

La ruta final usa un proveedor de rutas. La distancia en línea recta solo sirve para preseleccionar candidatos. La entrega requiere transición de estados, geolocalización aproximada, código o evidencia autorizada y sello temporal. Los eventos fuera de orden se rechazan.

### Incentivos

El pago debe combinar tarifa base, distancia o complejidad, tiempo activo y complementos transparentes. No se deben incentivar conductas inseguras. Las liquidaciones se calculan desde eventos de entrega y no desde el dispositivo del rider.

**Métricas:** tiempo de aceptación, tiempo de llegada a comercio, entregas a tiempo, tasa de reasignación, kilómetros por pedido, incidencias y ganancias netas por hora conectada.

## 4. PIKI Admin

### Máquina de estados y operaciones

Admin supervisa una máquina de estados única para pedidos, comercios y riders. Las transiciones inválidas generan alerta y no se corrigen con escrituras directas. Las acciones sensibles requieren rol, motivo y registro de auditoría.

### Riesgo y fraude

El baseline combina límites por cuenta, dispositivo e IP, velocidad de creación de pedidos, intentos de pago, reutilización anómala de direcciones y discrepancias de entrega. Las señales producen revisión o bloqueo temporal, nunca un veto irreversible automático en la primera versión.

### Soporte y reembolsos

Los casos se priorizan por dinero en riesgo, impacto en cliente, retraso y reincidencia. El reembolso debe ser idempotente y vinculado a un pedido. Las decisiones de soporte guardan motivo, agente, importe y evidencia.

### Analítica

Admin consulta proyecciones diarias y agregados, no todas las colecciones operativas. Los paneles muestran frescura de datos y distinguen métricas estimadas de confirmadas.

**Métricas:** tiempo de resolución, fraude confirmado, falsos positivos, reembolsos, tasa de errores de transición y disponibilidad de API.

## 5. PIKI Fleet

### Zonas y turnos

Las zonas se definen como polígonos versionados. Los turnos se asignan por disponibilidad declarada, capacidad de flota y demanda prevista. Se evita superar la carga objetivo por zona.

`cobertura_zona = riders_disponibles / pedidos_previstos`

Cuando la cobertura baja del umbral, Fleet propone refuerzo, cambio de turno o limitación temporal de promesa.

### Rendimiento

El rendimiento se calcula con entregas completadas, puntualidad, incidencias y tiempo activo. No se compara a riders con muestras pequeñas. Las liquidaciones separan tarifa, incentivos, ajustes y retenciones.

### Evolución

Con volumen suficiente, Fleet puede incorporar predicción de demanda por celda, optimización de turnos y batching limitado. El batching solo se admite si no aumenta la probabilidad de retraso por encima del umbral de servicio.

**Métricas:** cobertura, pedidos sin asignar, puntualidad por zona, utilización, coste por entrega y precisión de previsión.

## 6. PIKI API central

### Consistencia e idempotencia

Todos los comandos mutables requieren `idempotency-key`. Los documentos operativos se actualizan con control de versión y los eventos tienen identificador único. Las escrituras de asignación usan transacción o condición atómica.

### Resiliencia

Los adaptadores de pagos, mapas, mensajería y almacenamiento tendrán timeout, reintentos con backoff limitado, circuit breaker y fallback explícito. Un proveedor caído no debe bloquear toda la API. Se aplican paginación, límites de payload y respuestas 429.

### Geodatos e índices

MongoDB Atlas usa índices geoespaciales para comercios, riders y zonas, índices por estado y fecha para pedidos, e identificadores únicos para eventos. La ubicación exacta de riders se separa de los datos del cliente y tiene retención limitada.

### Seguridad y observabilidad

La API valida payloads, controla roles por endpoint, redacciona secretos en logs, correlaciona solicitudes con `request-id` y publica salud de aplicación y dependencias. Las métricas se agrupan por endpoint, estado, latencia y versión de regla.

**Métricas:** p95/p99, tasa 4xx/5xx, errores de idempotencia, latencia de dependencias, retraso de eventos y consumo por cliente.

## 7. PIKI web pública

La web pública no participa en el cálculo de pedidos. Su función es adquisición, confianza y descarga de apps. El algoritmo de contenidos debe priorizar claridad, SEO técnico, rendimiento, accesibilidad y conversión por ciudad.

Las páginas de ciudad y categoría deben generarse únicamente para zonas realmente servidas. No se publicarán comercios ficticios como si estuvieran disponibles. Las campañas se etiquetan con parámetros de atribución y se miden sin exponer datos personales innecesarios.

**Métricas:** velocidad de carga, conversión a instalación, clic a marketplace, registro, cobertura indexada y tasa de rebote cualificada.

## Orden recomendado de implementación

1. Máquina de estados de pedidos y catálogo server-side.
2. Cobertura, horarios, capacidad y ETA conservadora.
3. Checkout idempotente y eventos de pago.
4. Elegibilidad y asignación atómica de riders.
5. Paneles de operaciones y auditoría.
6. Zonas, turnos, liquidaciones y analítica.
7. Predicción, recomendaciones y optimización avanzada con datos reales.

## Fuentes técnicas de referencia

- [MongoDB geospatial queries](https://www.mongodb.com/docs/manual/geospatial-queries/)
- [OSRM API](https://project-osrm.org/docs/v5.5.1/api/)
- [Google OR-Tools: vehicle routing with time windows](https://developers.google.com/optimization/routing/vrptw)
- [OWASP API4: unrestricted resource consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/)
- [OWASP API security](https://owasp.org/API-Security/)
