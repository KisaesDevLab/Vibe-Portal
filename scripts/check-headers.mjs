// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Every source file starts with the PolyForm SPDX line.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['apps', 'packages', 'scripts'];
const EXT = /\.(ts|tsx|mjs|cjs|js|sql)$/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage']);
const LINE = /^(\/\/|--) SPDX-License-Identifier: PolyForm-Small-Business-1\.0\.0$/;

const missing = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (EXT.test(name)) {
      const first = readFileSync(p, 'utf8').split(/\r?\n/, 1)[0] ?? '';
      if (!LINE.test(first)) missing.push(relative(process.cwd(), p));
    }
  }
}
ROOTS.forEach(walk);
if (missing.length) {
  console.error(`Missing SPDX header:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
