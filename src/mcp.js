import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBrowser } from './index.js';
import { withDeadline } from './utils.js';

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const count = { type: 'integer', minimum: 0, maximum: 1000000 };
const seconds = { type: 'number', exclusiveMinimum: 0, maximum: 120 };
const milliseconds = { type: 'number', exclusiveMinimum: 0, maximum: 120000 };
const element = { ref: string, selector: string };
const definitions = [
  ['browser_navigate', 'Navigate to an HTTP(S) URL', { url: string, waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'] } }, ['url']],
  ['browser_snapshot', 'Get title, URL, visible text and interactive element refs', { max_chars: count }],
  ['browser_interactive_elements', 'Get current interactive element refs (previous refs expire)', { limit: count }],
  ['browser_click', 'Click an element using ref or selector', element],
  ['browser_fill', 'Replace an input value using ref or selector', { ...element, value: string }, ['value']],
  ['browser_type', 'Append text using ref or selector', { ...element, text: string }, ['text']],
  ['browser_press_key', 'Press a key, optionally focusing an element', { ...element, key: string }, ['key']],
  ['browser_select_option', 'Select an option by value', { ...element, value: string }, ['value']],
  ['browser_evaluate', 'Evaluate JavaScript; await promises; timeout closes the page', { expression: string, timeoutMs: milliseconds }, ['expression']],
  ['browser_wait_for', 'Wait for a CSS selector; timeout is in seconds', { selector: string, timeout: seconds }, ['selector']],
  ['browser_wait_for_function', 'Poll a JavaScript expression; timeout is in milliseconds', { function: string, timeout: milliseconds, pollIntervalMs: milliseconds }, ['function']],
  ['browser_wait_for_text', 'Wait for visible body text; timeout is in seconds', { text: string, timeout: seconds }, ['text']],
  ['browser_network_requests', 'List up to 2000 recent page requests', {}],
  ['browser_console_messages', 'List up to 1000 recent console messages', {}],
  ['browser_close', 'Close the page and reset cookies and state', {}],
  ['browser_markdown', 'Extract the current page as Markdown', { max_chars: count }],
  ['browser_links', 'List page links', { limit: count, internal_only: boolean }],
  ['browser_back', 'Navigate backward', {}],
  ['browser_forward', 'Navigate forward', {}],
  ['browser_reload', 'Reload the page', {}],
  ['browser_get_cookies', 'Read cookies, including HttpOnly cookies', {}],
  ['browser_set_cookie', 'Set a browser cookie', { name: string, value: string, domain: string, url: string, path: string, secure: boolean, http_only: boolean, expires: { type: 'number' }, same_site: { type: 'string', enum: ['Strict', 'Lax', 'None'] } }, ['name', 'value']],
  ['browser_clear_cookies', 'Delete all cookies in the current context', {}],
  ['browser_scroll', 'Scroll an element into view, or scroll by x/y pixels', { ...element, x: { type: 'number' }, y: { type: 'number' } }],
  ['browser_get_attribute', 'Read an element attribute', { ...element, name: string }, ['name']],
  ['browser_count', 'Count elements matching a CSS selector', { selector: string }, ['selector']],
  ['browser_extract', 'Extract text or one attribute from matching elements', { selector: string, attribute: string, limit: count }, ['selector']],
  ['browser_screenshot', 'Capture PNG; optionally write to a file', { path: string, full_page: boolean }],
  ['browser_pdf', 'Export A4 PDF; optionally write to a file', { path: string, print_background: boolean }],
];

export const mcpTools = definitions.map(([name, description, properties, required = []]) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
}));

function validateArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments debe ser un objeto');
  for (const key of tool.inputSchema.required) if (args[key] === undefined) throw new Error(`Falta ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = tool.inputSchema.properties[key];
    if (!rule) throw new Error(`Parámetro no admitido: ${key}`);
    if (rule.type === 'integer' ? !Number.isInteger(value) : typeof value !== rule.type) throw new Error(`Tipo no válido para ${key}`);
    if (rule.type === 'number' && !Number.isFinite(value)) throw new Error(`Número no válido para ${key}`);
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`Valor no válido para ${key}`);
    if (rule.minimum !== undefined && value < rule.minimum) throw new Error(`${key} debe ser >= ${rule.minimum}`);
    if (rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum) throw new Error(`${key} debe ser > ${rule.exclusiveMinimum}`);
    if (rule.maximum !== undefined && value > rule.maximum) throw new Error(`${key} debe ser <= ${rule.maximum}`);
  }
}

function textContent(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }] };
}

export function createMcpController(options = {}) {
  const browser = createBrowser(options);
  let session;
  let queue = Promise.resolve();
  async function current() {
    if (!session || session.closed || session.page.isClosed()) session = await browser.newPage();
    return session;
  }
  async function dispatch(name, args) {
    const tool = mcpTools.find(item => item.name === name);
    if (!tool) throw new Error(`Herramienta desconocida: ${name}`);
    validateArgs(tool, args);
    if (name === 'browser_close') {
      await session?.close(); session = undefined;
      return textContent('Página cerrada');
    }
    const s = await current();
    const p = s.page;
    let result;
    switch (name) {
      case 'browser_navigate':
        await s.navigate(args.url, { waitUntil: args.waitUntil });
        result = { url: p.url(), title: await p.title() }; break;
      case 'browser_snapshot': {
        const elements = await s.interactiveElements();
        const body = await s.dump('text');
        result = `URL: ${p.url().slice(0, 256)}\nTítulo: ${(await p.title()).slice(0, 256)}\n` +
          `${JSON.stringify(elements, null, 2)}\n${body}`.slice(0, args.max_chars ?? 4000);
        break;
      }
      case 'browser_interactive_elements': result = await s.interactiveElements(args.limit ?? 100); break;
      case 'browser_click': await s.useElement(args, handle => handle.click()); result = 'Click realizado'; break;
      case 'browser_fill':
        await s.useElement(args, handle => handle.evaluate((node, value) => {
          if (node.isContentEditable) node.textContent = value;
          else {
            const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (!setter) throw new Error('El elemento no admite texto');
            setter.call(node, value);
          }
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }, args.value));
        result = 'Campo rellenado'; break;
      case 'browser_type': await s.useElement(args, handle => handle.type(args.text)); result = 'Texto escrito'; break;
      case 'browser_press_key':
        if (args.ref || args.selector) await s.useElement(args, handle => handle.focus());
        await p.keyboard.press(args.key); result = 'Tecla pulsada'; break;
      case 'browser_select_option': result = await s.useElement(args, handle => handle.select(args.value)); break;
      case 'browser_evaluate': result = await s.evaluate(args.expression, args.timeoutMs ?? 5000); break;
      case 'browser_wait_for': {
        const handle = await p.waitForSelector(args.selector, { timeout: (args.timeout ?? 30) * 1000 });
        await handle?.dispose(); result = 'Selector encontrado'; break;
      }
      case 'browser_wait_for_function': {
        const handle = await p.waitForFunction(args.function, { timeout: args.timeout ?? 30000, polling: args.pollIntervalMs ?? 100 });
        await handle.dispose(); result = 'Condición cumplida'; break;
      }
      case 'browser_wait_for_text': {
        const handle = await p.waitForFunction(text => document.body?.innerText.includes(text), { timeout: (args.timeout ?? 30) * 1000 }, args.text);
        await handle.dispose(); result = 'Texto encontrado'; break;
      }
      case 'browser_network_requests': result = s.requests; break;
      case 'browser_console_messages': result = s.console; break;
      case 'browser_markdown': result = (await s.dump('markdown')).slice(0, args.max_chars ?? 4000); break;
      case 'browser_links':
        result = (await s.dump('links')).filter(link => !args.internal_only || new URL(link.href).origin === new URL(p.url()).origin).slice(0, args.limit ?? 100); break;
      case 'browser_back': await p.goBack(); result = p.url(); break;
      case 'browser_forward': await p.goForward(); result = p.url(); break;
      case 'browser_reload': await p.reload(); result = p.url(); break;
      case 'browser_get_cookies': result = await s.context.cookies(); break;
      case 'browser_set_cookie': {
        let domain = args.domain;
        if (args.url) {
          const { url } = await s.policy.validate(args.url);
          domain = url.hostname;
        }
        if (!domain) {
          if (!p.url().startsWith('http')) throw new Error('Indica domain o url para la cookie');
          domain = new URL(p.url()).hostname;
        }
        await s.context.setCookie({
          name: args.name, value: args.value, domain, path: args.path ?? '/',
          secure: args.secure ?? false, httpOnly: args.http_only ?? false,
          ...(args.expires !== undefined ? { expires: args.expires } : {}),
          ...(args.same_site ? { sameSite: args.same_site } : {}),
        });
        result = 'Cookie guardada'; break;
      }
      case 'browser_clear_cookies': {
        const cookies = await s.context.cookies();
        if (cookies.length) await s.context.deleteCookie(...cookies);
        result = 'Cookies eliminadas'; break;
      }
      case 'browser_scroll':
        if (args.ref || args.selector) await s.useElement(args, handle => handle.scrollIntoView());
        else await p.evaluate(({ x, y }) => window.scrollBy(x ?? 0, y ?? 600), args);
        result = 'Desplazamiento realizado'; break;
      case 'browser_get_attribute': result = await s.useElement(args, handle => handle.evaluate((node, key) => node.getAttribute(key), args.name)); break;
      case 'browser_count': result = await p.$$eval(args.selector, nodes => nodes.length); break;
      case 'browser_extract':
        result = await p.$$eval(args.selector, (nodes, { attribute, limit = 100 }) => nodes.slice(0, limit).map(node => attribute ? node.getAttribute(attribute) : node.textContent.trim()), args); break;
      case 'browser_screenshot': {
        const bytes = await p.screenshot({ path: args.path, type: 'png', fullPage: args.full_page ?? true });
        return { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from(bytes).toString('base64') }] };
      }
      case 'browser_pdf': {
        const bytes = await p.pdf({ path: args.path, format: 'A4', printBackground: args.print_background ?? true });
        return { content: [{ type: 'resource', resource: { uri: 'obscura://page.pdf', mimeType: 'application/pdf', blob: Buffer.from(bytes).toString('base64') } }] };
      }
      default: throw new Error(`Herramienta no implementada: ${name}`);
    }
    return textContent(result);
  }

  return {
    tools: mcpTools,
    call(name, args = {}) {
      const run = queue.then(async () => {
        const timeoutMs = name === 'browser_wait_for_function' ? args.timeout ?? 30000
          : name === 'browser_evaluate' ? args.timeoutMs ?? 5000
          : ['browser_wait_for', 'browser_wait_for_text'].includes(name) ? (args.timeout ?? 30) * 1000 : 30000;
        try {
          return await withDeadline(() => dispatch(name, args), Math.min(Math.max(Number(timeoutMs) || 30000, 1), 120000) + 1000, () => session?.close());
        } catch (error) {
          return { ...textContent(error.message), isError: true };
        }
      });
      queue = run.catch(() => {});
      return run;
    },
    async close() { await browser.close(); },
  };
}

export async function startMcp(options = {}) {
  const controller = createMcpController(options);
  const server = new Server({ name: 'obscura-js', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: controller.tools }));
  server.setRequestHandler(CallToolRequestSchema, request => controller.call(request.params.name, request.params.arguments));
  let closing;
  const onEnd = () => { void close(); };
  async function close() {
    closing ??= (async () => {
      process.stdin.off('end', onEnd);
      await controller.close();
      await server.close();
    })();
    return closing;
  }
  process.stdin.once('end', onEnd);
  server.onclose = () => { void close(); };
  await server.connect(new StdioServerTransport());
  return { close };
}
