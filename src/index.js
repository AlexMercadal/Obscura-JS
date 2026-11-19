import { BrowserSession, launchBrowser } from './browser.js';
import { NetworkPolicy } from './network.js';
import { mapBounded, positiveNumber, withDeadline } from './utils.js';

export { BrowserSession, findBrowser } from './browser.js';
export { NetworkPolicy, isPublicAddress } from './network.js';

/** Node.js API. Every newPage/fetch uses an isolated cookie/storage context. */
export class ObscuraBrowser {
  constructor(options = {}) {
    if (options.stealth) throw new Error('El modo stealth nativo de Obscura no está implementado en esta adaptación');
    this.options = options;
    this.policy = new NetworkPolicy(options);
    this.sessions = new Set();
    this.closed = false;
  }

  async engine() {
    if (this.closed) throw new Error('El navegador ya está cerrado');
    this.launching ??= launchBrowser(this.options);
    return this.launching;
  }

  async newPage(options = {}) {
    const session = await BrowserSession.create(await this.engine(), { ...this.options, ...options }, this.policy);
    if (this.closed) {
      await session.close();
      throw new Error('El navegador ya está cerrado');
    }
    this.sessions.add(session);
    const originalClose = session.close.bind(session);
    session.close = async () => {
      this.sessions.delete(session);
      await originalClose();
    };
    return session;
  }

  async fetch(url, options = {}) {
    const config = { ...this.options, ...options };
    const start = performance.now();
    const timeoutMs = positiveNumber(config.timeout ?? 30, 'timeout') * 1000;
    if (config.dump === 'original') {
      if (config.eval || config.selector || config.screenshot || config.pdf || config.wait !== undefined) {
        throw new Error('dump original no admite eval, selector, wait, screenshot ni pdf');
      }
      const response = await withDeadline(async () => {
        if (config.obeyRobots) await this.policy.checkRobots(url, config.timeout);
        return this.policy.raw(url, config);
      }, timeoutMs);
      return { url, finalUrl: response.url, status: response.status, data: response.body, elapsedMs: Math.round(performance.now() - start) };
    }
    let session;
    let expired = false;
    try {
      return await withDeadline(async () => {
        session = await this.newPage(config);
        if (expired) {
          await session.close();
          throw new Error('Tiempo máximo agotado durante la creación de página');
        }
        const response = await session.navigate(url, config);
        let value;
        if (config.eval !== undefined) value = await session.evaluate(config.eval, timeoutMs);
        await session.settle(config);
        if (config.screenshot) await session.page.screenshot({ path: config.screenshot, type: 'png', fullPage: true });
        if (config.pdf) await session.page.pdf({ path: config.pdf, format: 'A4', printBackground: true });
        const data = config.dump !== undefined || config.eval === undefined ? await session.dump(config.dump ?? 'html') : value;
        return { url, finalUrl: session.page.url(), status: response?.status() ?? null, data, elapsedMs: Math.round(performance.now() - start) };
      }, timeoutMs, () => { expired = true; return session?.close(); });
    } finally {
      await session?.close();
    }
  }

  async scrape(urls, options = {}) {
    if (!Array.isArray(urls)) throw new Error('urls debe ser un array');
    if (options.dump === 'original') throw new Error('Para descargas originales usa fetch, no scrape');
    return mapBounded(urls, options.concurrency ?? 10, async url => {
      const start = performance.now();
      try {
        return { ...await this.fetch(url, options), ok: true };
      } catch (error) {
        return { url, ok: false, error: error.message, elapsedMs: Math.round(performance.now() - start) };
      }
    });
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await Promise.allSettled([...this.sessions].map(session => session.close()));
      if (this.launching) {
        const browser = await this.launching.catch(() => null);
        await browser?.close();
      }
      this.policy.close();
    })();
    return this.closing;
  }
}

export function createBrowser(options = {}) {
  return new ObscuraBrowser(options);
}

export async function fetchPage(url, options = {}) {
  const browser = createBrowser(options);
  try { return await browser.fetch(url, options); } finally { await browser.close(); }
}

export async function scrape(urls, options = {}) {
  const browser = createBrowser(options);
  try { return await browser.scrape(urls, options); } finally { await browser.close(); }
}
