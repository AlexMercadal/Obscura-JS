import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowser, fetchPage } from '../src/index.js';
import { binary, fixtureServer, fixtureProxy } from './fixtures.js';

let fixture; let browser; let outputDir;
before(async () => {
  fixture = await fixtureServer();
  outputDir = await mkdtemp(join(tmpdir(), 'obscura-js-test-'));
  browser = createBrowser({ allowPrivateNetwork: true });
});
after(async () => {
  await browser?.close(); await fixture?.close();
  if (outputDir) await rm(outputDir, { recursive: true, force: true });
});

test('descarga bytes binarios y sigue redirecciones sin iniciar Chromium', async () => {
  const raw = createBrowser({ allowPrivateNetwork: true, browserPath: 'missing-browser' });
  try {
    const result = await raw.fetch(`${fixture.url}/redirect`, { dump: 'original' });
    assert.deepEqual(result.data, binary);
    assert.equal(result.status, 200);
    assert.equal(result.finalUrl, `${fixture.url}/binary`);
    assert.equal(raw.launching, undefined);
  } finally { await raw.close(); }
});

test('ejecuta scripts y espera al contenido dinámico', async () => {
  const result = await browser.fetch(fixture.url, { dump: 'text', selector: '.ready' });
  assert.match(result.data, /Hola Obscura/);
  assert.match(result.data, /Contenido dinámico/);
  assert.doesNotMatch(result.data, /console\.log/);
});

test('extrae HTML, enlaces, Markdown y recursos', async () => {
  const html = await browser.fetch(fixture.url, { dump: 'html', selector: '.ready' });
  assert.match(html.data, /class="ready"/);
  const links = await browser.fetch(fixture.url, { dump: 'links' });
  assert.deepEqual(links.data, [{ text: 'Siguiente', href: `${fixture.url}/next` }]);
  const markdown = await browser.fetch(fixture.url, { dump: 'markdown', selector: '.ready' });
  assert.match(markdown.data, /# Hola Obscura/);
  assert.doesNotMatch(markdown.data, /console\.log/);
  const assets = await browser.fetch(fixture.url, { dump: 'assets', selector: '.ready' });
  assert.ok(assets.data.some(item => item.url === `${fixture.url}/style.css`));
});

test('eval devuelve valores y promesas; eval con dump lee el DOM modificado', async () => {
  const evaluated = await browser.fetch(fixture.url, { eval: 'Promise.resolve({title: document.title, n: 42})' });
  assert.deepEqual(evaluated.data, { title: 'Obscura fixture', n: 42 });
  const changed = await browser.fetch(fixture.url, { eval: 'document.querySelector("h1").textContent = "Cambiado"', dump: 'text' });
  assert.match(changed.data, /Cambiado/);
  await assert.rejects(browser.fetch(fixture.url, { eval: 'throw new Error("fixture failure")' }), /fixture failure/);
});

test('incluye cookies HttpOnly y aísla cookies entre páginas', async () => {
  const cookies = await browser.fetch(`${fixture.url}/cookie`, { dump: 'cookies' });
  assert.ok(cookies.data.some(cookie => cookie.name === 'session' && cookie.httpOnly));
  const fresh = await browser.fetch(`${fixture.url}/cookie-state`, { dump: 'text' });
  assert.match(fresh.data, /sin cookies/);
});

test('scrape conserva el orden y devuelve errores por URL', async () => {
  const urls = [`${fixture.url}/delay/100`, `${fixture.url}/delay/5`, 'file:///example'];
  const results = await browser.scrape(urls, { concurrency: 2, eval: 'document.querySelector("h1").textContent' });
  assert.deepEqual(results.map(result => result.url), urls);
  assert.equal(results[0].data, '/delay/100');
  assert.equal(results[1].data, '/delay/5');
  assert.equal(results[2].ok, false);
  assert.match(results[2].error, /Protocolo/);
});

test('produce capturas PNG y PDF válidos', async () => {
  const screenshot = join(outputDir, 'page.png'); const pdf = join(outputDir, 'page.pdf');
  await browser.fetch(fixture.url, { screenshot, pdf, selector: '.ready', dump: 'text' });
  assert.deepEqual((await readFile(screenshot)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal((await readFile(pdf)).subarray(0, 5).toString(), '%PDF-');
});

test('respeta robots.txt y envía el User-Agent configurado', async () => {
  const robot = createBrowser({ allowPrivateNetwork: true, obeyRobots: true, userAgent: 'ObscuraTest/1' });
  try {
    await assert.rejects(robot.fetch(`${fixture.url}/blocked`, { dump: 'original' }), /robots.txt/);
    await assert.rejects(robot.fetch(`${fixture.url}/blocked`, { dump: 'text' }), /robots.txt/);
    assert.ok(!fixture.hits.includes('/blocked'));
    const ua = await robot.fetch(`${fixture.url}/user-agent`, { dump: 'text' });
    assert.equal(ua.data.trim(), 'ObscuraTest/1');
  } finally { await robot.close(); }
});

test('las descargas bloquean redes privadas por defecto', async () => {
  await assert.rejects(fetchPage(fixture.url, { dump: 'original', allowPrivateNetwork: false }), /Red privada/);
});

test('proxy HTTP autenticado: original y navegación pasan por el proxy', async () => {
  const proxy = await fixtureProxy(fixture.url);
  const proxied = createBrowser({ allowPrivateNetwork: true, proxy: proxy.url });
  try {
    const raw = await proxied.fetch(`${fixture.url}/binary`, { dump: 'original' });
    assert.deepEqual(raw.data, binary);
    assert.ok(proxy.requests.includes(`${fixture.url}/binary`));
    const rendered = await proxied.fetch(fixture.url, { dump: 'text', selector: '.ready' });
    assert.match(rendered.data, /Contenido dinámico/);
    assert.ok(proxy.requests.includes(`${fixture.url}/`));
    assert.ok(proxy.requests.includes(`${fixture.url}/json`));
  } finally { await proxied.close(); await proxy.close(); }
});

test('cancela navegación y JavaScript infinito; el navegador sigue sirviendo páginas nuevas', async () => {
  await assert.rejects(browser.fetch(`${fixture.url}/never`, { timeout: 0.4 }), /[Tt]iempo|timeout/i);
  await assert.rejects(browser.fetch(fixture.url, { eval: 'while (true) {}', timeout: 1 }), /[Tt]iempo|timed out/i);
  const result = await browser.fetch(fixture.url, { eval: 'document.title' });
  assert.equal(result.data, 'Obscura fixture');
  assert.equal(browser.sessions.size, 0);
});
