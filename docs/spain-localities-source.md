# Catálogo municipal de España (INE)

`src/data/spain-localities.json` es una copia byte a byte del dataset oficial validado para esta entrega. Contiene 8.132 códigos municipales únicos de cinco dígitos, 52 provincias (incluidas Ceuta y Melilla), nombres oficiales, población y alias trazables. SHA-256: `caadc980a77eeea9ee5b0e2a30b56f198d801162ca0c00b231f4dfaa33d79780`.

La fuente de códigos es [diccionario26.xlsx](https://www.ine.es/daco/daco42/codmun/diccionario26.xlsx), referencia 2026-01-01, contrastada con `26codmun.xlsx`. Se aplicaron los 15 cambios oficiales de denominación de 2026 publicados hasta 2026-11-11 en la [página de modificaciones del INE](https://www.ine.es/daco/daco42/codmun/codmun_anual.htm). Las cifras oficiales de población corresponden a 2025, extraídas del ZIP nacional [pobmun.zip](https://www.ine.es/pob_xls/pobmun.zip), miembro `pobmun/pobmun25.xlsx`.

La extracción validó todos los códigos y recuentos provinciales contra el INE, cero poblaciones nulas, y los 275 municipios de población estrictamente superior a 30.000 habitantes. Los 869 alias de 717 municipios se limitan a denominaciones anteriores oficiales, formas bilingües literales y reordenación del artículo final. La búsqueda elimina tildes para comparar, sin alterar las denominaciones oficiales devueltas.

Este es un catálogo municipal, **no** un nomenclátor de todas las aldeas, barrios, núcleos o entidades de población. Los alias no son exhaustivos. La presencia de un municipio no acredita partners ni cobertura comercial/de reparto. No contiene coordenadas inventadas. La política de cobertura de checkout continúa separada y sin cambios.

Las evidencias completas, originales y extractor reproducible de esta entrega están en `/home/ubuntu/piki-audit/localities-source.md`, `/home/ubuntu/piki-audit/sources/`, `/home/ubuntu/piki-audit/scripts/extract_spain_localities.py` y `/home/ubuntu/piki-audit/data/spain-localities-validation.json`; no son dependencias del runtime de la API.
