# Algoritmos y decisiones operativas de PIKI Delivery

**PIKI Delivery** debe empezar con reglas explicables, datos trazables y límites operativos claros. En una primera ciudad, la prioridad no es usar inteligencia artificial compleja: es aceptar solo los pedidos que se pueden cumplir, calcular una promesa de entrega prudente y asignar cada pedido sin crear carreras entre riders.

## Principios de diseño

Las decisiones deben registrar sus entradas, el algoritmo o regla aplicado, los candidatos excluidos y el resultado. Esto permite explicar por qué un comercio dejó de aparecer, por qué un rider fue asignado o por qué se mostró una ETA concreta. Los modelos predictivos solo deben sustituir a una regla base cuando demuestren una mejora sostenida contra datos de validación.

## Decisiones necesarias antes de escalar

| Decisión | Baseline de lanzamiento | Evolución cuando exista volumen |
|---|---|---|
| Cobertura | Polígonos de zona y validación de punto dentro de la zona. | Ajuste de zonas con propuestas revisadas por operaciones. |
| Disponibilidad de comercio | Horario, estado manual, capacidad por franja y cola de preparación. | Predicción de capacidad por franja y alertas de sobrecarga. |
| Ranking de catálogo | Calidad, proximidad, tiempo de preparación y diversidad; las promociones se etiquetan por separado. | Personalización con exploración controlada y límites de exposición. |
| ETA | Preparación estimada más viaje a recogida y viaje a destino; se muestra un intervalo conservador. | Modelo calibrado por zona, franja, tipo de comercio y vehículo. |
| Asignación de rider | Filtro por zona, ubicación reciente, vehículo, carga y coste de recogida. | Matching bipartito y batching limitado con protección de puntualidad. |
| Ruta | Proveedor de rutas, caché corta y fallback de distancia aproximada solo para preselección. | Inserción de paradas con ventanas temporales y optimización VRPTW. |
| Riesgo y fraude | Límites por cuenta, dispositivo e IP; validación de payload y estados. | Reglas de anomalías y revisión manual de señales agregadas. |

## Algoritmo de asignación inicial

PIKI debe considerar un rider elegible únicamente si está activo, dentro de la zona operativa, tiene señal GPS reciente, vehículo compatible y carga disponible. Para cada candidato se calcula un coste explicable: tiempo de llegada al comercio, retraso esperado al cliente, carga activa, ajuste a la zona y prioridad de servicio. Se reserva el rider mediante una actualización atómica antes de notificar la asignación. Si no se confirma en el tiempo definido, la reserva expira y se vuelve a evaluar la cola.

> La distancia en línea recta es útil para reducir candidatos, pero no puede utilizarse como ETA final. La promesa al cliente debe proceder de una ruta o de una estimación conservadora basada en trayectos reales.

## ETA y comunicación con cliente

La ETA se compone de la preparación estimada del comercio, el desplazamiento del rider hasta la recogida y el trayecto hasta el cliente. En la primera versión, PIKI debe usar medianas por comercio y franjas horarias, y debe añadir un margen de seguridad basado en percentiles altos. La aplicación mostrará intervalos, por ejemplo “25–35 min”, en vez de una hora exacta que no se puede garantizar.

## Catálogo, recomendaciones y equidad

El ranking no debe depender solo de ventas o de reseñas brutas. Una media bayesiana evita que un establecimiento nuevo con pocas opiniones supere injustamente a otros. La diversidad mínima evita mostrar siempre los mismos comercios. Las promociones se marcan como contenido comercial y no sustituyen la señal de calidad.

## Privacidad y resiliencia

Las ubicaciones de riders se conservan con una política de retención limitada y se separan de los datos de cliente. Los paneles solo muestran la precisión necesaria para el rol de operación. La API aplica paginación, validación de esquemas, límites de consumo y respuestas `429`. Los proveedores de rutas, pagos y mensajería se envuelven con timeout, reintentos controlados y circuit breakers.

## Arquitectura de datos inicial

MongoDB Atlas guarda documentos operativos de restaurantes, riders, flotas y pedidos. Los índices iniciales cubren actividad y categoría de comercio, estados y fechas de pedido, identificadores públicos y posiciones geoindexadas. Para consultas analíticas complejas se crearán proyecciones de lectura y agregados diarios en lugar de leer todas las colecciones en cada pantalla.

## Referencias

[1]: https://www.mongodb.com/docs/manual/geospatial-queries/ "MongoDB geospatial queries"
[2]: https://project-osrm.org/docs/v5.5.1/api/ "OSRM API documentation"
[3]: https://developers.google.com/optimization/routing/vrptw "Google OR-Tools: Vehicle Routing Problem with Time Windows"
[4]: https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/ "OWASP API4:2023 Unrestricted Resource Consumption"
[5]: https://dl.acm.org/doi/10.1145/3494530 "FoodMatch: recommendation and matching research"
