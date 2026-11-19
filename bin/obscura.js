#!/usr/bin/env node
import { Command, Option } from 'commander';
import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createBrowser } from '../src/index.js';
import { formatOutput, nonNegativeNumber, positiveNumber } from '../src/utils.js';

const program = new Command();
let active;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await active?.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void shutdown().then(() => { process.exitCode = 0; }); });
}
process.stdout.on('error', error => {
  if (error.code === 'EPIPE') void shutdown();
  else throw error;
});

const positive = value => positiveNumber(value);
const integer = value => positiveNumber(value, 'valor', true);
const nonNegative = value => nonNegativeNumber(value);
function globalOptions(command) { return command.optsWithGlobals(); }
function create(command) {
  active = createBrowser(globalOptions(command));
  return active;
}
async function output(value, path, dump) {
  const formatted = formatOutput(value, dump);
  if (path) await writeFile(path, formatted);
  else if (Buffer.isBuffer(formatted) || formatted instanceof Uint8Array) process.stdout.write(formatted);
  else process.stdout.write(`${formatted}\n`);
}
function pageOptions(command) {
  return command
    .addOption(new Option('--dump <format>', 'Formato de extracción').choices(['html', 'text', 'links', 'markdown', 'assets', 'original', 'cookies']))
    .option('-e, --eval <expression>', 'Ejecutar JavaScript dentro de la página')
    .option('--selector <css>', 'Esperar a que aparezca un selector')
    .option('--wait <seconds>', 'Espera adicional en segundos', nonNegative)
    .addOption(new Option('--wait-until <event>', 'Evento de navegación').choices(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).default('load'))
    .option('--timeout <seconds>', 'Tiempo máximo total por URL', positive, 30)
    .option('-o, --output <file>', 'Guardar la salida en un archivo');
}

program.name('obscura-js').version('0.1.0')
  .description('Adaptación JavaScript de Obscura con Chrome/Edge (motor Chromium)')
  .option('--browser-path <path>', 'Ruta del ejecutable Chrome/Edge/Chromium')
  .option('--proxy <url>', 'Proxy HTTP/HTTPS/SOCKS')
  .option('--user-agent <value>', 'User-Agent personalizado')
  .option('--allow-private-network', 'Permitir localhost y redes privadas')
  .option('--obey-robots', 'Respetar robots.txt')
  .option('--stealth', 'No disponible: se informa como error')
  .option('-q, --quiet', 'Reducir mensajes de progreso');

pageOptions(program.command('fetch <url>').description('Obtener una página o recurso'))
  .option('-s, --screenshot <file>', 'Guardar una captura PNG de la página completa')
  .option('--pdf <file>', 'Guardar la página como PDF A4')
  .action(async (url, _options, command) => {
    const options = globalOptions(command);
    const browser = create(command);
    try {
      const result = await browser.fetch(url, options);
      await output(result.data, options.output, options.dump);
    } finally { await browser.close(); }
  });

pageOptions(program.command('scrape <urls...>').description('Extraer varias páginas con concurrencia limitada'))
  .option('--concurrency <number>', 'Número de páginas simultáneas', integer, 10)
  .addOption(new Option('--format <format>', 'Formato de resultados').choices(['json', 'text']).default('json'))
  .action(async (urls, _options, command) => {
    const options = globalOptions(command);
    const browser = create(command);
    try {
      const results = await browser.scrape(urls, options);
      const data = options.format === 'json' ? results : results.map(item =>
        item.ok ? `${item.url}\n${formatOutput(item.data, options.dump)}` : `${item.url}\nERROR: ${item.error}`
      ).join('\n\n');
      await output(data, options.output);
      if (results.some(item => !item.ok)) process.exitCode = 1;
    } finally { await browser.close(); }
  });

program.command('serve').description('Exponer el CDP nativo de Chromium en 127.0.0.1')
  .option('-p, --port <number>', 'Puerto TCP', integer, 9222)
  .action(async (_options, command) => {
    const options = globalOptions(command);
    if (options.port > 65535) throw new Error('port debe ser <= 65535');
    if (options.obeyRobots) throw new Error('--obey-robots no se puede imponer a los clientes CDP de serve');
    const browser = create(command);
    try {
      const engine = await browser.engine();
      if (!options.quiet) console.error('CDP nativo: los clientes tienen control completo del navegador y de su red.');
      console.error(`HTTP: http://127.0.0.1:${options.port}`);
      console.error(`WebSocket: ${engine.wsEndpoint()}`);
      await once(engine, 'disconnected');
    } finally { await browser.close(); }
  });

program.command('mcp').description('Servidor MCP por stdio para agentes')
  .action(async (_options, command) => {
    const { startMcp } = await import('../src/mcp.js');
    active = await startMcp(globalOptions(command));
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
  await shutdown();
}
