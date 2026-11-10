import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

test('src/core 는 electron 을 import하지 않는다', () => {
  const offenders = tsFiles(resolve(__dirname, '../../src/core')).filter((f) => {
    const src = readFileSync(f, 'utf8');
    return /from ['"]electron['"]/.test(src) || /require\(['"]electron['"]\)/.test(src);
  });
  expect(offenders).toEqual([]);
});
