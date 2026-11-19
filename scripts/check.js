import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = new URL('../', import.meta.url);
for (const directory of ['src', 'bin', 'test', 'examples', 'scripts']) {
  for (const file of await readdir(new URL(`${directory}/`, root))) {
    if (!file.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit', cwd: root });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log('Sintaxis JavaScript correcta.');
