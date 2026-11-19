import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import puppeteer from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpController } from '../src/mcp.js';
import { fixtureServer, binary } from './fixtures.js';
import { withDeadline } from '../src/utils.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/obscura.js', import.meta.url));
let fixture;
before(async () => { fixture = await fixtureServer(); });
after(async () => { await fixture?.close(); });

function text(result) {
  assert.ok(!result.isError, result.content[0]?.text);
  return result.content[0]?.text;
}

test('CLI: argumentos globales antes/después, eval, salida binaria y errores', async () => {
  const first = await exec(process.execPath, [cli, '--allow-private-network', 'fetch', fixture.url, '--eval', 'document.title']);
  assert.equal(first.stdout.trim(), 'Obscura fixture');
  const second = await exec(process.execPath, [cli, 'fetch', `${fixture.url}/binary`, '--allow-private-network', '--dump', 'original'], { encoding: 'buffer' });
  assert.deepEqual(second.stdout, binary);
  const dir = await mkdtemp(join(tmpdir(), 'obscura-cli-test-'));
  try {
    const output = join(dir, 'result.json');
    await exec(process.execPath, [cli, 'scrape', fixture.url, `${fixture.url}/next`, '--allow-private-network', '--eval', 'document.title', '--output', output, '--concurrency', '2']);
    const results = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.ok && result.data === 'Obscura fixture'));
  } finally { await rm(dir, { recursive: true, force: true }); }
  await assert.rejects(exec(process.execPath, [cli, 'scrape', fixture.url, '--concurrency', '0']), error => error.code === 1 && /mayor que cero/.test(error.stderr));
  await assert.rejects(exec(process.execPath, [cli, 'fetch', fixture.url, '--stealth']), error => error.code === 1 && /no está implementado/.test(error.stderr));
  await assert.rejects(exec(process.execPath, [cli, 'scrape', 'file:///example']), error => error.code === 1 && JSON.parse(error.stdout)[0].ok === false);
});

test('MCP: navegación, refs, formularios, cookies, contenido, capturas y validación', async () => {
  const controller = createMcpController({ allowPrivateNetwork: true });
  try {
    assert.equal(JSON.parse(text(await controller.call('browser_navigate', { url: fixture.url }))).title, 'Obscura fixture');
    text(await controller.call('browser_wait_for', { selector: '.ready' }));
    assert.match(text(await controller.call('browser_snapshot')), /Hola Obscura/);
    const refs = JSON.parse(text(await controller.call('browser_interactive_elements')));
    const input = refs.find(item => item.tag === 'input');
    text(await controller.call('browser_fill', { ref: input.ref, value: 'Ana' }));
    text(await controller.call('browser_type', { ref: input.ref, text: ' María' }));
    text(await controller.call('browser_click', { selector: '#action' }));
    text(await controller.call('browser_wait_for_text', { text: 'Ana María' }));
    assert.equal(text(await controller.call('browser_evaluate', { expression: 'document.querySelector("#name").value' })), 'Ana María');
    text(await controller.call('browser_select_option', { selector: '#choice', value: 'b' }));
    assert.equal(text(await controller.call('browser_count', { selector: 'option' })), '2');
    assert.equal(text(await controller.call('browser_get_attribute', { selector: '#name', name: 'name' })), 'name');
    assert.deepEqual(JSON.parse(text(await controller.call('browser_extract', { selector: 'h1' }))), ['Hola Obscura']);
    text(await controller.call('browser_set_cookie', { name: 'mcp', value: 'cookie', http_only: true }));
    assert.ok(JSON.parse(text(await controller.call('browser_get_cookies'))).some(item => item.name === 'mcp' && item.httpOnly));
    text(await controller.call('browser_clear_cookies'));
    assert.deepEqual(JSON.parse(text(await controller.call('browser_get_cookies'))), []);
    assert.match(text(await controller.call('browser_markdown')), /# Hola Obscura/);
    assert.equal(JSON.parse(text(await controller.call('browser_links')))[0].text, 'Siguiente');
    assert.ok(JSON.parse(text(await controller.call('browser_network_requests'))).some(item => item.url.endsWith('/json')));
    assert.ok(JSON.parse(text(await controller.call('browser_console_messages'))).some(item => item.text === 'fixture ready'));
    const screenshot = await controller.call('browser_screenshot');
    assert.equal(screenshot.content[0].type, 'image');
    assert.equal(screenshot.content[0].mimeType, 'image/png');
    const pdf = await controller.call('browser_pdf');
    assert.equal(Buffer.from(pdf.content[0].resource.blob, 'base64').subarray(0, 5).toString(), '%PDF-');
    text(await controller.call('browser_click', { selector: '#submit' }));
    text(await controller.call('browser_wait_for_function', { function: 'location.pathname === "/submitted"' }));
    assert.equal((await controller.call('browser_fill', { ref: input.ref, value: 'stale' })).isError, true);
    assert.equal((await controller.call('browser_navigate', {})).isError, true);
    assert.equal((await controller.call('browser_evaluate', { expression: '1', timeoutMs: -1 })).isError, true);
    assert.equal((await controller.call('browser_nonexistent', {})).isError, true);
    text(await controller.call('browser_close'));
    text(await controller.call('browser_navigate', { url: fixture.url }));
  } finally { await controller.close(); }
});

test('MCP: un timeout de promesa cierra la página y permite volver a navegar', async () => {
  const controller = createMcpController({ allowPrivateNetwork: true });
  try {
    text(await controller.call('browser_navigate', { url: fixture.url }));
    const result = await controller.call('browser_evaluate', { expression: 'new Promise(() => {})', timeoutMs: 100 });
    assert.equal(result.isError, true);
    text(await controller.call('browser_navigate', { url: fixture.url }));
  } finally { await controller.close(); }
});

test('MCP stdio: el SDK oficial inicializa, lista e invoca herramientas', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--allow-private-network'], stderr: 'pipe' });
  const client = new Client({ name: 'obscura-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'browser_navigate'));
    text(await client.callTool({ name: 'browser_navigate', arguments: { url: fixture.url } }));
    assert.equal(text(await client.callTool({ name: 'browser_evaluate', arguments: { expression: 'document.title' } })), 'Obscura fixture');
    text(await client.callTool({ name: 'browser_close', arguments: {} }));
  } finally { await client.close(); }
});

test('CDP serve: discovery HTTP, conexión Puppeteer y cierre limpio', async () => {
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, [cli, 'serve', '--port', String(port), '--quiet'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = ''; let remote;
  try {
    await withDeadline(() => new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stderr.on('data', chunk => { stderr += chunk; if (stderr.includes('WebSocket:')) resolve(); });
      child.once('exit', code => reject(new Error(`serve terminó (${code}): ${stderr}`)));
    }), 15000);
    remote = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const page = await remote.newPage();
    await page.goto(fixture.url);
    assert.equal(await page.title(), 'Obscura fixture');
    await remote.close(); remote = undefined;
    const [code] = await withDeadline(() => exited, 10000);
    assert.equal(code, 0, stderr);
  } finally {
    if (remote) await remote.close().catch(() => {});
    if (child.exitCode === null) child.kill();
  }
});
