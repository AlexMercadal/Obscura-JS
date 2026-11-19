import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, NetworkPolicy } from '../src/network.js';
import { mapBounded, positiveNumber, formatOutput } from '../src/utils.js';

test('bloquea rangos internos, reservados y direcciones IPv4 mapeadas en IPv6', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:192.168.1.1', 'nonsense']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});

test('valida DNS local, protocolos y permiso explícito de red privada', async () => {
  const policy = new NetworkPolicy({ allowPrivateNetwork: false });
  await assert.rejects(policy.validate('http://localhost/'), /Red privada/);
  await assert.rejects(policy.validate('http://2130706433/'), /Red privada/);
  await assert.rejects(policy.validate('file:///etc/passwd'), /Protocolo/);
  await assert.rejects(policy.validate('http://user:password@example.com'), /credenciales/);
  const allowed = new NetworkPolicy({ allowPrivateNetwork: true });
  assert.equal((await allowed.validate('http://127.0.0.1/')).url.hostname, '127.0.0.1');
});

test('limita la concurrencia, rellena huecos sin esperar al primer resultado y conserva el orden', async () => {
  let active = 0; let maximum = 0;
  const finished = [];
  const results = await mapBounded([80, 5, 5, 5], 2, async (delay, index) => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, delay));
    active--; finished.push(index); return index;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(results, [0, 1, 2, 3]);
  assert.deepEqual(finished, [1, 2, 3, 0]);
  await assert.rejects(mapBounded([1], 0, () => {}), /mayor que cero/);
});

test('rechaza números inválidos y conserva bytes originales', () => {
  for (const invalid of [NaN, Infinity, 0, -1, 'invalid']) assert.throws(() => positiveNumber(invalid));
  const bytes = Buffer.from([0, 255]);
  assert.equal(formatOutput(bytes), bytes);
  assert.equal(formatOutput([{ url: 'a' }, { url: 'b' }], 'assets'), '{"url":"a"}\n{"url":"b"}');
});
