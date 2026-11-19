# Obscura JS

Adaptación funcional en **JavaScript para Node.js**, basada en las interfaces de usuario de [Obscura](https://github.com/h4ckf0r0day/obscura), revisión `8a8a53f0cf129031f9546eab2b40810c30e9b9ef`.

El código de esta adaptación es JavaScript ESM (`.js`); no necesita compilar Rust ni TypeScript. La navegación, el DOM y el renderizado los realiza **Chrome, Edge o Chromium mediante Puppeteer**. El motor Rust de Obscura, su consumo de memoria y su modo stealth nativo no se han trasladado. Consulta [MIGRACION.md](MIGRACION.md) para conocer el alcance.

## Requisitos e instalación

- Node.js 22.12 o posterior.
- Chrome, Edge o Chromium instalado; no se descarga un navegador durante `npm install`.

```powershell
git clone https://github.com/AlexMercadal/Obscura-JS.git
cd Obscura-JS
npm ci
npm start -- --help
```

Se detectan las rutas habituales de Windows, macOS y Linux. Para otras instalaciones:

```powershell
$env:OBSCURA_BROWSER_PATH = 'C:\ruta\chrome.exe'
# Alternativa por comando:
npm start -- --browser-path 'C:\ruta\chrome.exe' fetch https://example.com --dump text
```

`PUPPETEER_EXECUTABLE_PATH` también es compatible. `--dump original` no necesita navegador.

## Uso por terminal

```powershell
# Título, HTML renderizado, texto, enlaces, Markdown, recursos o cookies
npm start -- fetch https://example.com --eval "document.title"
npm start -- fetch https://example.com --dump html
npm start -- fetch https://example.com --dump text --output pagina.txt
npm start -- fetch https://example.com --dump links
npm start -- fetch https://example.com --dump markdown
npm start -- fetch https://example.com --dump assets
npm start -- fetch https://example.com --dump cookies

# Esperar contenido dinámico
npm start -- fetch https://example.com --selector h1 --wait-until networkidle0 --timeout 30

# PNG de página completa y PDF A4
npm start -- fetch https://example.com --screenshot pagina.png --pdf pagina.pdf --dump text

# Recurso binario: --output evita que la consola transforme los bytes
node bin/obscura.js fetch https://example.com --dump original --output respuesta.bin

# Extracción concurrente: mantiene el orden de las URL
npm start -- scrape https://example.com https://example.org --concurrency 2 --eval "document.title" --format json

# Proxy y robots.txt (opciones globales, antes o después del subcomando)
npm start -- --proxy http://127.0.0.1:8080 fetch https://example.com --dump text
npm start -- --obey-robots fetch https://example.com --dump text

# Servidores de desarrollo locales
npm start -- fetch http://127.0.0.1:3000 --allow-private-network --dump text
```

También puedes ejecutar `node bin/obscura.js ...`. Esta forma evita las cabeceras de npm al redirigir resultados o usar protocolos por stdio.

`--dump assets` devuelve NDJSON; `links` y `cookies`, arrays JSON. `--eval` devuelve su resultado, con espera de promesas. Si combinas `--eval` con `--dump`, se ejecuta el código y se extrae después el DOM modificado. Para devolver valores desde varias instrucciones, usa una IIFE: `(() => { const n = 42; return n; })()`.

`--timeout` limita el trabajo completo por URL, incluido eval y capturas. `--wait` añade una espera fija en segundos, dentro de ese límite. La espera predeterminada es el evento `load`; utiliza `--selector` o `--wait-until networkidle0` para contenido tardío. `--dump original` descarga mediante HTTP de Node, sigue hasta 10 redirecciones y admite hasta 64 MiB por respuesta de forma predeterminada. No ejecuta scripts, no mantiene cookies y no se combina con eval, selector, wait, screenshot ni pdf.

`scrape` devuelve `{ url, finalUrl, status, data, elapsedMs, ok }` por éxito y `{ url, ok: false, error, elapsedMs }` por error. Cada URL utiliza un contexto aislado. Los fallos de transporte, ejecución o tiempo generan un error; un HTTP 404/500 sigue siendo una respuesta y su código se incluye en `status`. La CLI termina con código 1 si alguna URL falla. `--format text` produce una salida legible.

## API JavaScript

```javascript
import { createBrowser, fetchPage, scrape } from './src/index.js';

const result = await fetchPage('https://example.com', { dump: 'text' });
console.log(result.data);

const results = await scrape(['https://example.com', 'https://example.org'], {
  concurrency: 2,
  eval: 'document.title',
});
console.log(results);

// Reutilizar el proceso del navegador; cookies aisladas en cada fetch/newPage.
const browser = createBrowser({ allowPrivateNetwork: false });
try {
  const session = await browser.newPage();
  try {
    await session.navigate('https://example.com');
    console.log(await session.evaluate('document.title'));
    // Acceso directo a Page de Puppeteer para automatización avanzada:
    await session.page.screenshot({ path: 'ejemplo.png', fullPage: true });
  } finally {
    await session.close();
  }
} finally {
  await browser.close();
}
```

Las opciones de red, proxy, navegador y User-Agent se configuran al crear el navegador. `fetch` acepta `dump`, `eval`, `selector`, `wait`, `waitUntil`, `timeout`, `screenshot` y `pdf`. La API usa camelCase; la CLI usa guiones.

## Servidor CDP

```powershell
node bin/obscura.js serve --port 9222
```

El proceso imprime la dirección real de WebSocket de Chromium. Descubrimiento HTTP: `http://127.0.0.1:9222/json/version`.

```javascript
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
const page = await browser.newPage();
await page.goto('https://example.com');
console.log(await page.title());
await browser.disconnect();
```

Con Playwright, usa `chromium.connectOverCDP('http://127.0.0.1:9222')` desde un proyecto que lo tenga instalado. No se ha incluido Playwright como dependencia.

El servidor escucha en loopback y ofrece el CDP nativo de Chromium. Los clientes CDP controlan directamente el navegador, sus páginas y su red: los filtros de `fetch`/`scrape`/MCP y `robots.txt` no se imponen a esos clientes. No utiliza el endpoint fijo `/devtools/browser` de Obscura; usa discovery o la URL impresa. Ctrl+C detiene el servidor.

## Servidor MCP

```powershell
node bin/obscura.js mcp
```

Ejemplo de configuración para un cliente MCP que admita servidores por stdio:

```json
{
  "mcpServers": {
    "obscura-js": {
      "command": "node",
      "args": ["C:/repos/Obscura-JS/bin/obscura.js", "mcp"]
    }
  }
}
```

El SDK oficial gestiona inicialización y transporte; stdout se reserva para MCP. Se exponen 29 herramientas: navegar, snapshot, elementos interactivos, click, fill, type, press_key, select_option, evaluate, esperas de selector/función/texto, peticiones, consola, cerrar, Markdown, enlaces, historial, cookies, scroll, atributos, count, extract, screenshot y PDF. La lista exacta y sus esquemas se obtienen con `tools/list`.

Las llamadas se serializan y conservan la página y sus cookies. Las referencias `eN` proceden de `browser_snapshot` o `browser_interactive_elements` y caducan al navegar o solicitar otra lista de elementos. `browser_close` cierra el contexto y la próxima navegación crea uno limpio. Los timeouts de eval cierran la página para detener la ejecución. El transporte MCP HTTP y la gestión de pestañas del original no están implementados.

## Red y proxies

Se rechazan destinos HTTP(S) privados, loopback y link-local por defecto. Para desarrollo local utiliza `--allow-private-network` o `OBSCURA_ALLOW_PRIVATE_NETWORK=1`. Las peticiones HTTP directas fijan la dirección IP validada; las páginas de Chromium filtran navegación y subrecursos mediante interceptación, con bypass de service workers. Ese filtro no constituye aislamiento de red completo: Chromium resuelve DNS por su cuenta, las páginas pueden abrir otros canales como WebSocket y los clientes CDP pueden controlar la red. Para ejecutar páginas no confiables en entornos sensibles, aplica además una política de red externa.

Se soportan proxies HTTP/HTTPS y SOCKS sin autenticación en Chromium; los proxies HTTP pueden usar usuario y contraseña en la URL. SOCKS autenticado se rechaza en navegación porque Chromium no lo admite. El descargador HTTP de Node admite los proxies de `proxy-agent`. Un proxy remoto puede resolver el destino de forma diferente al DNS local. No se usan automáticamente las variables HTTP_PROXY/HTTPS_PROXY: configura `--proxy`.

## Validación

```powershell
npm run check
npm test
```

Las pruebas sirven páginas locales y ejecutan Chrome/Edge sin ventana. Cubren DOM dinámico, formatos, cookies, formularios, concurrencia, errores, timeouts, binarios, PNG/PDF, CLI, MCP con el SDK oficial y CDP con Puppeteer. No requieren páginas externas. El motor Rust original se conserva intacto y no se compila para estas pruebas.

Licencia Apache-2.0; atribución y revisión de referencia en [NOTICE](NOTICE).
