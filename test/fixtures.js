import http from 'node:http';
import { once } from 'node:events';

export const binary = Buffer.from([0, 255, 13, 10, 128, 42, 0]);
export async function fixtureServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/robots.txt') {
      res.setHeader('content-type', 'text/plain'); return res.end('User-agent: *\nDisallow: /blocked');
    }
    if (url.pathname === '/binary') {
      res.setHeader('content-type', 'application/octet-stream'); return res.end(binary);
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/binary' }); return res.end();
    }
    if (url.pathname === '/json') {
      res.setHeader('content-type', 'application/json'); return res.end('{"message":"Contenido dinámico"}');
    }
    if (url.pathname === '/style.css') {
      res.setHeader('content-type', 'text/css'); return res.end('body {font:16px sans-serif;color:#123} h1 {color:#246}');
    }
    if (url.pathname === '/never') return;
    if (url.pathname.startsWith('/delay/')) {
      return setTimeout(() => {
        res.setHeader('content-type', 'text/html');
        res.end(`<h1>${url.pathname}</h1>`);
      }, Number(url.pathname.split('/').at(-1)));
    }
    if (url.pathname === '/cookie') res.setHeader('set-cookie', 'session=fixture; HttpOnly; Path=/');
    if (url.pathname === '/cookie-state') {
      res.setHeader('content-type', 'text/html'); return res.end(`<h1>${req.headers.cookie || 'sin cookies'}</h1>`);
    }
    if (url.pathname === '/user-agent') {
      res.setHeader('content-type', 'text/html'); return res.end(`<h1>${req.headers['user-agent']}</h1>`);
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>Obscura fixture</title><link rel="stylesheet" href="/style.css"></head>
      <body><h1>Hola Obscura</h1><p id="dynamic">Cargando</p><a href="/next">Siguiente</a>
      <form action="/submitted"><label>Nombre<input name="name" id="name"></label><button id="submit">Enviar</button></form>
      <button id="action" onclick="document.querySelector('#dynamic').textContent = document.querySelector('#name').value">Actualizar</button>
      <select id="choice"><option value="a">A</option><option value="b">B</option></select>
      <script>console.log('fixture ready'); fetch('/json').then(r=>r.json()).then(data=>{
        document.querySelector('#dynamic').textContent=data.message;
        document.querySelector('#dynamic').className='ready';
      });</script></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`, hits,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

export async function fixtureProxy(targetOrigin) {
  const requests = [];
  const expectedAuth = `Basic ${Buffer.from('user:pass').toString('base64')}`;
  const server = http.createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== expectedAuth) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="fixture"' }); return res.end();
    }
    const url = new URL(req.url);
    if (url.origin !== targetOrigin) { res.writeHead(502); return res.end(); }
    requests.push(req.url);
    const headers = { ...req.headers }; delete headers['proxy-authorization'];
    const upstream = http.request(url, { method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.on('connect', (_req, socket) => { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    url: `http://user:pass@localhost:${server.address().port}`, requests,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
