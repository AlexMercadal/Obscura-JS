# Validación de la entrega

Fecha: 19 de noviembre de 2026.

Entorno comprobado: Windows, Node.js v26.8.1, npm 11.19.0 y Chrome 157.0.8103.79.

- `npm run check`: sintaxis correcta en fuentes, CLI, ejemplos y pruebas.
- `npm test`: **20 pruebas superadas; 0 fallidas, omitidas o canceladas**. Duración aproximada: 23 segundos.
- MCP: inicialización, listado e invocación mediante el cliente del SDK oficial; 29 herramientas publicadas.
- CDP: descubrimiento HTTP, conexión Puppeteer, navegación y cierre del servidor.
- Navegador: contenido dinámico, formatos de extracción, eval/promesas, cookies HttpOnly, aislamiento, formularios, refs, PNG, PDF, robots.txt, User-Agent y recuperación tras timeouts de navegación y scripts infinitos.
- Red: binarios, redirecciones, clasificación de IP, bloqueo privado y proxy HTTP autenticado tanto en Node como en Chromium.
- CLI: opciones globales antes/después del subcomando, archivos de salida, JSON, binarios y códigos de error.
- `git -C ../obscura-original status --short`: sin cambios.

Las pruebas usan servidores locales temporales; no dependen de páginas públicas. No se ha probado esta entrega en Linux/macOS, con Playwright, proxies HTTPS/SOCKS ni todas las herramientas de historial/scroll en cada situación. El motor Rust original no se ha compilado ni se ha ejecutado su benchmark; estas pruebas validan la adaptación JavaScript.
