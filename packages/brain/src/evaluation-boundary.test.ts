import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { exports: Record<string, { types?: string; default?: string }> };
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const publicEvaluationSource = readFileSync(
  new URL('./public-evaluation-composition.ts', import.meta.url),
  'utf8',
);
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

function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe('ADR-0021 production evaluation boundary', () => {
  it('exposes only the research-safe composed evaluation API as a public statistical subpath', () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual(['.', './evaluation-composition']);
    for (const subpath of forbiddenPublicSubpaths) {
      expect(packageJson.exports[subpath]).toBeUndefined();
    }
    expect(packageJson.exports['./evaluation-composition']).toEqual({
      types: './dist/public-evaluation-composition.d.ts',
      default: './dist/public-evaluation-composition.js',
    });
    expect(publicEvaluationSource).toContain('buildResearchSafeFinalEvaluation');
    expect(publicEvaluationSource).not.toContain('buildFinalPreRegisteredEvaluation');
    expect(publicEvaluationSource).not.toContain('validateFinalEvaluationComposition');
  });

  it('does not smuggle low-level evaluators back through the package root', () => {
    for (const modulePath of forbiddenRootReExports) {
      expect(indexSource).not.toContain(`export * from '${modulePath}'`);
      expect(indexSource).not.toContain(`export * from "${modulePath}"`);
    }
  });

  it('prevents production workspace code from deep-importing Brain internals', () => {
    const violations: string[] = [];
    const roots = ['apps', 'services', 'packages'].map((path) => join(repoRoot, path));

    for (const root of roots) {
      for (const path of sourceFiles(root)) {
        if (path.startsWith(join(repoRoot, 'packages', 'brain'))) continue;
        const source = readFileSync(path, 'utf8');
        for (const specifier of moduleSpecifiers(source)) {
          if (
            specifier.startsWith('@keel/brain/') &&
            specifier !== '@keel/brain/evaluation-composition'
          ) {
            violations.push(`${relative(repoRoot, path)}: forbidden ${specifier}`);
          }
          if (
            specifier.includes('packages/brain/src/') ||
            specifier.includes('packages\\brain\\src\\')
          ) {
            violations.push(`${relative(repoRoot, path)}: direct ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
