import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const serverSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

describe('ADR-0018 source-level order boundary', () => {
  it('contains no direct POST /orders execution handler', () => {
    expect(serverSource).not.toMatch(/app\.post\(\s*['"]\/orders['"]/);
  });

  it('keeps order creation delegated to the Mission route surface', () => {
    expect(serverSource).toContain('registerMissionRoutes(app, deps, parseSubmit');
  });
});
