# Alcance de la adaptación

Obscura es un navegador completo escrito en Rust. Una reescritura de su motor implica DOM, parser HTML/CSS, layout, rasterizado, red, bindings V8 y protocolo CDP. Este proyecto adapta sus funciones de uso a JavaScript y delega el motor en Chromium. No es una traducción línea a línea ni una versión con paridad total.

| Área original | Implementación JavaScript | Alcance |
| --- | --- | --- |
| CLI Rust | `bin/obscura.js` con Commander | `fetch`, `scrape`, `serve`, `mcp` |
| Navegación y sesiones | `src/browser.js`, `src/index.js` | Puppeteer con un contexto aislado por página de API |
| Runtime V8, DOM y CSS | Chrome/Edge/Chromium instalado | Se delegan al navegador; sin código Rust propio |
| Red y descarga original | `src/network.js` | HTTP(S), redirecciones, bytes binarios, proxy y robots.txt |
| Extracción | `BrowserSession.dump()` | HTML, texto, enlaces, Markdown, recursos y cookies |
| Ejecución JavaScript | CDP `Runtime.evaluate` | Valores serializables, promesas y límite de tiempo |
| Renderizado | `Page.screenshot()` y `Page.pdf()` | PNG completo y PDF A4 de Chromium |
| Paralelismo por procesos | Cola acotada en `src/utils.js` | Páginas aisladas, resultados en orden; no pool de procesos Rust |
| CDP propio | CDP nativo de Chromium | Discovery HTTP y endpoint WebSocket real |
| MCP | `src/mcp.js`, SDK oficial | 29 herramientas por stdio, una página con estado |
| Apache-2.0 | `LICENSE`, `NOTICE` | Licencia y atribución conservadas |

## Funciones sin paridad

- Motor de navegador independiente, renderizado sin Chromium, objetivos de memoria y velocidad del original.
- Stealth nativo: suplantación TLS/BoringSSL, fingerprints y lista de bloqueo de rastreadores. `--stealth` devuelve un error explícito.
- Supervisión y reciclado de workers, límites RSS, múltiples procesos y opciones avanzadas de `serve`.
- `fetch --file`, almacenamiento persistente `--storage-dir`, fuentes personalizadas, flags V8 y opciones no listadas por `--help`.
- MCP por HTTP, pestañas, restauración de storage y herramientas del original que no aparezcan en `tools/list`.
- Dominio CDP específico `LP.getMarkdown`; utiliza la API JS, `--dump markdown` o la herramienta MCP.
- Filtro SSRF equivalente al de Rust: la interceptación Chromium no controla todos sus canales de red ni fija su resolución DNS. En `serve`, el cliente controla directamente Chromium.

## Diferencias de comportamiento

- Se requiere Node.js y un navegador Chromium instalado para navegación y renderizado; `original` solo requiere Node.js.
- No se promete paridad de flags, esquemas de resultados ni de todas las herramientas MCP. Las opciones implementadas están en `--help` y `tools/list`; las desconocidas se rechazan.
- `fetch` emite únicamente el resultado de la extracción; los metadatos se obtienen mediante la API. `scrape` emite un array con `ok`, `data`, `status` y `elapsedMs`.
- `--wait` es una espera fija; no hay espera adaptativa predeterminada. La espera por defecto es `load`.
- El timeout de `fetch` es un límite para la operación completa, incluido el arranque si aún no se ha iniciado el navegador. En `scrape` se aplica a cada trabajo.
- El formato `original` descarga sin JavaScript, sin cookie jar y sin contexto de navegador. Su límite predeterminado es 64 MiB; mediante la API se puede pasar `maxBytes`.
- Cada `fetch`/`newPage` tiene cookies y storage aislados. Una `BrowserSession` conserva estado mientras permanezca abierta; MCP mantiene una única sesión hasta `browser_close`.
- Los assets incluyen recursos observados en Performance y atributos habituales del DOM, sin pretender reproducir exactamente el grafo de recursos de Rust.
- `serve` utiliza la URL de WebSocket generada por Chromium, no una ruta fija. Los clientes CDP tienen control completo del navegador.

## Código fuente original

La copia descargada permanece en `../obscura-original`, revisión `8a8a53f0cf129031f9546eab2b40810c30e9b9ef`. No se ha modificado, compilado ni publicado ningún cambio en GitHub.
