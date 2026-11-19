import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import TurndownService from 'turndown';
import { NetworkPolicy } from './network.js';
import { nonNegativeNumber, positiveNumber, withDeadline } from './utils.js';

export async function findBrowser(explicitPath) {
  const configured = explicitPath || process.env.OBSCURA_BROWSER_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = configured ? [configured] : [
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate, constants.F_OK); return candidate; } catch { /* Try next path. */ }
  }
  throw new Error('No se encuentra Chrome/Edge/Chromium. Instálalo o indica --browser-path / OBSCURA_BROWSER_PATH');
}

export async function launchBrowser(options = {}) {
  if (options.stealth) throw new Error('El modo stealth nativo de Obscura no está implementado en esta adaptación');
  const args = ['--disable-background-networking', '--disable-quic'];
  if (options.proxy) {
    const proxy = new URL(options.proxy);
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(proxy.protocol)) throw new Error('Protocolo de proxy no válido');
    if (proxy.protocol.startsWith('socks') && (proxy.username || proxy.password)) {
      throw new Error('Chromium no admite autenticación SOCKS. Usa un proxy HTTP autenticado o SOCKS sin credenciales');
    }
    proxy.username = ''; proxy.password = '';
    args.push(`--proxy-server=${proxy.protocol}//${proxy.host}`, '--proxy-bypass-list=<-loopback>');
  }
  if (options.userAgent) args.push(`--user-agent=${options.userAgent}`);
  return puppeteer.launch({
    executablePath: await findBrowser(options.browserPath),
    headless: true,
    args,
    debuggingPort: options.port ?? 0,
    defaultViewport: { width: 1280, height: 800 },
    timeout: 30000,
  });
}

export class BrowserSession {
  static async create(browser, options = {}, policy = new NetworkPolicy(options)) {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      const session = new BrowserSession(context, page, policy, options);
      await session.configure();
      return session;
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  constructor(context, page, policy, options) {
    this.context = context;
    this.page = page;
    this.policy = policy;
    this.options = options;
    this.console = [];
    this.requests = [];
    this.blocked = new Map();
    this.closed = false;
    this.refHandles = new Map();
    this.nextRef = 1;
  }

  async configure() {
    const { page, options } = this;
    page.setDefaultTimeout(positiveNumber(options.timeout ?? 30, 'timeout') * 1000);
    await page.setBypassServiceWorker(true);
    await page.setCacheEnabled(false);
    if (options.userAgent) await page.setUserAgent(options.userAgent);
    if (options.proxy) {
      const proxy = new URL(options.proxy);
      if (proxy.username) await page.authenticate({ username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) });
    }
    page.on('console', message => {
      this.console.push({ type: message.type(), text: message.text() });
      if (this.console.length > 1000) this.console.shift();
    });
    page.on('pageerror', error => {
      this.console.push({ type: 'error', text: String(error) });
      if (this.console.length > 1000) this.console.shift();
    });
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) void this.clearRefs();
    });
    await page.setRequestInterception(true);
    page.on('request', request => { void this.handleRequest(request); });
  }

  async handleRequest(request) {
    const url = request.url();
    this.requests.push({ url, method: request.method(), type: request.resourceType() });
    if (this.requests.length > 2000) this.requests.shift();
    try {
      if (url.startsWith('http:') || url.startsWith('https:')) {
        await this.policy.validate(url);
        if (this.options.obeyRobots && request.isNavigationRequest()) {
          await this.policy.checkRobots(url, this.options.timeout ?? 30);
        }
      } else if (!/^(data:|blob:|about:blank$)/.test(url)) {
        throw new Error(`Protocolo bloqueado: ${url.split(':')[0]}`);
      }
      if (!request.isInterceptResolutionHandled()) await request.continue();
    } catch (error) {
      this.blocked.set(url, error.message);
      if (this.blocked.size > 1000) this.blocked.delete(this.blocked.keys().next().value);
      if (!request.isInterceptResolutionHandled()) await request.abort('blockedbyclient').catch(() => {});
    }
  }

  async navigate(url, options = {}) {
    await this.policy.validate(url);
    this.blocked.clear();
    const timeout = positiveNumber(options.timeout ?? this.options.timeout ?? 30, 'timeout') * 1000;
    const waitUntil = options.waitUntil ?? 'load';
    if (!['load', 'domcontentloaded', 'networkidle0', 'networkidle2'].includes(waitUntil)) throw new Error('waitUntil no válido');
    try {
      return await this.page.goto(url, { timeout, waitUntil });
    } catch (error) {
      const blocked = this.blocked.get(url) || this.blocked.get(this.page.url());
      if (blocked) throw new Error(blocked);
      throw error;
    }
  }

  async evaluate(expression, timeoutMs = 5000) {
    positiveNumber(timeoutMs, 'timeoutMs');
    const client = await this.page.createCDPSession();
    try {
      return await withDeadline(async () => {
        const result = await client.send('Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs, userGesture: true,
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        }
        if (result.result.unserializableValue) return result.result.unserializableValue;
        return result.result.value ?? null;
      }, timeoutMs, () => this.close());
    } finally {
      await client.detach().catch(() => {});
    }
  }

  async settle({ selector, wait, timeout = 30 } = {}) {
    if (selector) {
      const element = await this.page.waitForSelector(selector, { timeout: positiveNumber(timeout, 'timeout') * 1000 });
      await element?.dispose();
    }
    if (wait !== undefined) {
      await new Promise(resolve => setTimeout(resolve, nonNegativeNumber(wait, 'wait') * 1000));
    }
  }

  async dump(format = 'html') {
    switch (format) {
      case 'html': return this.page.content();
      case 'text': return this.page.evaluate(() => document.body?.innerText ?? '');
      case 'cookies': return this.context.cookies();
      case 'links': return this.page.$$eval('a[href]', links => links.map(link => ({ text: link.textContent.trim(), href: link.href })));
      case 'markdown': {
        const html = await this.page.$eval('body', body => {
          const clone = body.cloneNode(true);
          clone.querySelectorAll('script,style,noscript,template').forEach(node => node.remove());
          return clone.innerHTML;
        });
        return new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(html);
      }
      case 'assets': return this.page.evaluate(() => {
        const assets = [];
        const seen = new Set();
        const add = (url, type) => {
          if (!url || seen.has(url)) return;
          seen.add(url); assets.push({ url, type });
        };
        for (const entry of performance.getEntriesByType('resource')) add(entry.name, entry.initiatorType);
        for (const node of document.querySelectorAll('[src],link[href],object[data],video[poster]')) {
          add(node.currentSrc || node.src || node.href || node.data || node.poster, node.tagName.toLowerCase());
        }
        return assets;
      });
      default: throw new Error(`Formato no válido: ${format}`);
    }
  }

  async clearRefs() {
    const handles = [...this.refHandles.values()];
    this.refHandles.clear();
    await Promise.allSettled(handles.map(handle => handle.dispose()));
  }

  async interactiveElements(limit = 100) {
    nonNegativeNumber(limit, 'limit');
    await this.clearRefs();
    const handles = await this.page.$$('a[href],button,input,textarea,select,[role="button"],[contenteditable="true"]');
    const result = [];
    for (const handle of handles) {
      const info = result.length < limit ? await handle.evaluate(element => {
        if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return null;
        return {
          tag: element.tagName.toLowerCase(), type: element.type,
          text: (element.getAttribute('aria-label') || element.labels?.[0]?.textContent || element.innerText || element.placeholder || '').trim().slice(0, 200),
          value: element.type === 'password' ? undefined : element.value,
          disabled: Boolean(element.disabled),
        };
      }) : null;
      if (info) {
        const ref = `e${this.nextRef++}`;
        this.refHandles.set(ref, handle);
        result.push({ ref, ...info });
      } else await handle.dispose();
    }
    return result;
  }

  async element({ ref, selector }) {
    if (ref) {
      const handle = this.refHandles.get(ref);
      if (!handle || !await handle.evaluate(node => node.isConnected)) throw new Error(`Referencia caducada: ${ref}. Solicita otro snapshot`);
      return { handle, owned: false };
    }
    if (!selector) throw new Error('Indica ref o selector');
    const handle = await this.page.waitForSelector(selector);
    if (!handle) throw new Error(`Elemento no encontrado: ${selector}`);
    return { handle, owned: true };
  }

  async useElement(args, action) {
    const { handle, owned } = await this.element(args);
    try { return await action(handle); } finally { if (owned) await handle.dispose(); }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.clearRefs();
    await this.context.close().catch(() => {});
  }
}
