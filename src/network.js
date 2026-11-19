import { lookup } from 'node:dns/promises';
import { lookup as lookupCallback } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import { ProxyAgent } from 'proxy-agent';
import robotsParser from 'robots-parser';
import { positiveNumber } from './utils.js';

export function isPublicAddress(address) {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  return parsed.range() === 'unicast';
}

export class NetworkPolicy {
  constructor(options = {}) {
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? process.env.OBSCURA_ALLOW_PRIVATE_NETWORK === '1';
    this.proxy = options.proxy;
    this.userAgent = options.userAgent || 'ObscuraJS/0.1';
    this.robots = new Map();
    this.agent = this.proxy ? new ProxyAgent({ getProxyForUrl: () => this.proxy }) : undefined;
  }

  async validate(input) {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Protocolo no permitido: ${url.protocol}`);
    if (url.username || url.password) throw new Error('No incluyas credenciales en la URL de destino');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length) throw new Error(`No se pudo resolver ${hostname}`);
    if (!this.allowPrivateNetwork && addresses.some(item => !isPublicAddress(item.address))) {
      throw new Error(`Red privada bloqueada: ${hostname}. Usa --allow-private-network para permitirla`);
    }
    return { url, addresses };
  }

  async raw(input, { timeout = 30, maxBytes = 64 * 1024 * 1024 } = {}) {
    const deadline = Date.now() + positiveNumber(timeout, 'timeout') * 1000;
    let current = input;
    for (let redirects = 0; redirects <= 10; redirects++) {
      const { url, addresses } = await this.validate(current);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Tiempo máximo de descarga agotado');
      const response = await new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        // Pin direct connections to an address checked above, avoiding a second DNS lookup.
        const pinnedLookup = (host, opts, callback) => {
          // Proxy agents resolve their own endpoint through this hook too.
          if (host.replace(/^\[|\]$/g, '') !== url.hostname.replace(/^\[|\]$/g, '')) {
            return lookupCallback(host, opts, callback);
          }
          const choices = opts.family ? addresses.filter(item => item.family === opts.family) : addresses;
          if (!choices.length) return callback(new Error('No hay direcciones para la familia IP solicitada'));
          callback(null, ...(opts.all ? [choices] : [choices[0].address, choices[0].family]));
        };
        const request = transport.get(url, {
          agent: this.agent,
          lookup: pinnedLookup,
          headers: { 'user-agent': this.userAgent, 'accept-encoding': 'identity' },
        }, res => {
          const chunks = [];
          let size = 0;
          res.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) res.destroy(new Error(`Respuesta mayor de ${maxBytes} bytes`));
            else chunks.push(chunk);
          });
          res.on('end', () => resolve({ url: url.href, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        });
        const timer = setTimeout(() => request.destroy(new Error('Tiempo máximo de descarga agotado')), remaining);
        request.on('close', () => clearTimeout(timer));
        request.on('error', reject);
      });
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        current = new URL(response.headers.location, current).href;
        continue;
      }
      const encoding = response.headers['content-encoding'];
      const limit = { maxOutputLength: maxBytes };
      if (encoding === 'gzip') response.body = gunzipSync(response.body, limit);
      if (encoding === 'deflate') response.body = inflateSync(response.body, limit);
      if (encoding === 'br') response.body = brotliDecompressSync(response.body, limit);
      return response;
    }
    throw new Error('Demasiadas redirecciones (máximo 10)');
  }

  async checkRobots(input, timeout = 30) {
    const url = new URL(input);
    const robotsUrl = `${url.origin}/robots.txt`;
    if (!this.robots.has(robotsUrl)) {
      const response = await this.raw(robotsUrl, { timeout, maxBytes: 1024 * 1024 });
      if (response.status >= 500) throw new Error(`robots.txt no disponible: HTTP ${response.status}`);
      const body = response.status === 401 || response.status === 403
        ? 'User-agent: *\nDisallow: /'
        : response.status >= 400 ? '' : response.body.toString('utf8');
      this.robots.set(robotsUrl, robotsParser(robotsUrl, body));
    }
    if (this.robots.get(robotsUrl).isAllowed(url.href, this.userAgent) === false) {
      throw new Error(`robots.txt impide acceder a ${url.href}`);
    }
  }

  close() {
    this.agent?.destroy();
  }
}
