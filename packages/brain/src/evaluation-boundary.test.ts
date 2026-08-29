import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { exports: Record<string, unknown> };
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const forbiddenPublicSubpaths = [
  './dependence-aware-evaluation',
  './dependence-guard',
  './episode-balanced-inference',
  './evaluation-pipeline',
  './feature-strata-guard',
  './longitudinal-maturity',
  './mission-evaluation',
  './outcome-labeling',
  './paired-inference',
  './pre-registered-evaluation',
  './snapshot-feature-strata',
  './strata-aware-evaluation',
];

const forbiddenRootReExports = [
  './evaluation.js',
  './paired-evaluation.js',
  './paired-inference.js',
];

const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

describe('ADR-0021 production evaluation boundary', () => {
  it('exposes only the composed evaluation API as a public statistical subpath', () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual(['.', './evaluation-composition']);
    for (const subpath of forbiddenPublicSubpaths) {
      expect(packageJson.exports[subpath]).toBeUndefined();
    }
  });

  it('does not smuggle low-level evaluators back through the package root', () => {
    for (const modulePath of forbiddenRootReExports) {
      expect(indexSource).not.toContain(`export * from '${modulePath}'`);
      expect(indexSource).not.toContain(`export * from "${modulePath}"`);
    }
  });

  it('prevents production workspace code from deep-importing Brain internals', () => {
    const violations: string[] = [];
    const roots = ['apps', 'services', 'packages']
      .map((path) => join(repoRoot, path))
      .filter((path) => path !== join(repoRoot, 'packages', 'brain'));

    for (const root of roots) {
      for (const path of sourceFiles(root)) {
        if (path.startsWith(join(repoRoot, 'packages', 'brain'))) continue;
        const source = readFileSync(path, 'utf8');
        const packageImports = source.matchAll(/@keel\/brain\/([A-Za-z0-9._/-]+)/g);
        for (const match of packageImports) {
          if (match[1] !== 'evaluation-composition') {
            violations.push(`${relative(repoRoot, path)}: forbidden @keel/brain/${match[1]}`);
          }
        }
        if (source.includes('packages/brain/src/') || source.includes('packages\\brain\\src\\')) {
          violations.push(`${relative(repoRoot, path)}: direct packages/brain/src deep import`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
