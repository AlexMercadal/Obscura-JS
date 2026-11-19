export function positiveNumber(value, name = 'valor', integer = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) {
    throw new Error(`${name} debe ser ${integer ? 'un entero' : 'un número'} mayor que cero`);
  }
  return number;
}

export function nonNegativeNumber(value, name = 'valor') {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} debe ser un número mayor o igual a cero`);
  return number;
}

export async function withDeadline(task, ms, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Tiempo máximo agotado (${ms} ms)`));
          Promise.resolve().then(onTimeout).catch(() => {});
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function mapBounded(items, concurrency, job) {
  positiveNumber(concurrency, 'concurrency', true);
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await job(items[index], index);
    }
  }));
  return results;
}

export function formatOutput(value, dump) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (dump === 'assets') return value.map(item => JSON.stringify(item)).join('\n');
  return typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
}
