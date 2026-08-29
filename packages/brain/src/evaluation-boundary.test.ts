import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { exports: Record<string, unknown> };
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

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
      expect(indexSource).not.toContain(`export * from \"${modulePath}\"`);
    }
  });
});
