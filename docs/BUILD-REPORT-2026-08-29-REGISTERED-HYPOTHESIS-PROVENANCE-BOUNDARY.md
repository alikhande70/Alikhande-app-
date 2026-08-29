# Build Report — Registered Hypothesis Provenance Boundary

Date: 2026-08-29  
Branch: `gpt/trading-brain-build`  
Architecture: ADR-0021 evaluation integrity

## Objective

Continue the ADR-0021 sequencing gate after durable hypothesis-family registration. The goal of this milestone is to make caller-authored registration receipts unacceptable at the Desk research boundary and to prevent a shortcut that exposes the low-level registered-hypothesis/FDR evaluator as a public production API.

This milestone deliberately does **not** start ADR-0020 Memory and does not claim ADR-0021 is complete.

## Repository / CI baseline

The run began by inspecting the latest branch and CI state. Baseline head `5f286a29bb8a2a0db345e874e0f64a267a88f730` had successful verification. The protected reference branch `claude/personal-trading-app-atm6e1` remained unchanged at `fdfc9daff888229ccefe01977f91988a0caa9d5d`.

The repository audit corrected an important assumption from the previous report: `packages/brain/src/registered-hypotheses.ts` was already private. The package exports only the package root and `./evaluation-composition`; the FDR evaluator was not publicly exported. The actual remaining problem was therefore composition/provenance, not a pre-existing public bypass.

## Accepted implementation

### Desk research provenance boundary

Added `services/desk/src/research/registered-family-boundary.ts`.

The boundary accepts only a `familyId`. It obtains the authoritative registration by reading the hash-chained Desk ledger and then derives the Brain-compatible immutable family plus `{ familyHash, knownAt }` receipt from that durable fact.

The boundary therefore does not accept a caller-provided `familyHash` or `knownAt` value. Unknown families fail closed instead of receiving an invented receipt.

### Red-team coverage

Added `services/desk/src/research/registered-family-boundary.test.ts` with four cases:

1. family and receipt are derived from the durable ledger and `knownAt` equals actual ledger transaction time;
2. an unknown family fails closed and does not create ledger data;
3. duplicate raw durable registration facts are rejected through the authoritative registration reader;
4. an impossible bitemporal state where durable transaction time predates declared registration time is rejected.

The boundary inherits hash verification, exactly-once registration semantics, restart safety and duplicate detection from the existing durable hypothesis-registration layer rather than reimplementing a second source of truth.

### Brain public-boundary regression guard

Strengthened `packages/brain/src/evaluation-boundary.test.ts` so CI explicitly forbids:

- a public `./registered-hypotheses` package subpath;
- a root re-export of `./registered-hypotheses.js`;
- exposing `evaluateRegisteredHypothesisFamily` through `public-evaluation-composition.ts`;
- exposing `RegisteredHypothesisFamilyReceipt` through that public statistical surface.

This makes a future shortcut that turns caller-constructible receipts into a public production evaluator a CI architecture violation.

## Rejected / reverted experiment

An initial composition experiment added a direct `@keel/brain` dependency from Desk and temporarily exposed the registered-hypothesis evaluator through the public evaluation subpath.

GitHub Actions correctly failed `pnpm install --frozen-lockfile` because the Desk package manifest had changed without a regenerated lockfile. Rather than weaken frozen-lockfile verification, hand-edit dependency state, or leave the evaluator surface wider than intended, the experiment was fully reverted.

The accepted implementation therefore keeps the existing dependency graph and private Brain evaluator boundary intact while establishing and testing the authoritative Desk provenance read.

## Verification ladder

### Failed dependency experiment

Verify run #949 on head `e3dd81f9cc10bbd29c496f01722a1de36b8ee1cc` failed at dependency installation with `ERR_PNPM_OUTDATED_LOCKFILE`. No typecheck or tests ran. This was treated as a real repository-integrity failure and fixed before further development.

### Formatting failure after accepted changes

After the dependency/API experiment was reverted, verify run #960 reached `pnpm verify` but failed during Biome lint only. The reported import ordering and restored `services/desk/tsconfig.json` formatting were corrected exactly as reported; no production invariant, statistical guard or test assertion was weakened.

### Verified implementation head

Implementation head `b8a93ff592229dea45eb455e02172a28eb8841d7` passed the complete GitHub Actions verify chain in run #967:

- frozen-lockfile dependency install: PASS;
- Biome: PASS, 262 files checked;
- TypeScript typecheck: PASS for Brain, Contracts, Core, Mobile and Desk;
- Contracts: 19 tests PASS;
- Core: 218 tests PASS;
- Brain: 164 tests PASS;
- Mobile: 132 tests PASS;
- Desk: 532 tests PASS;
- total: **1,065 tests PASS**;
- new registered-family provenance suite: **4/4 PASS**;
- existing durable hypothesis-registration suite: **8/8 PASS**;
- Brain evaluation-boundary suite: **3/3 PASS**.

Desk verification remains simulation/non-live and excludes `**/*.live.test.ts`. No live broker validation is claimed.

## Self-audit

### Closed in this milestone

The Desk research boundary no longer needs to trust a caller-authored `familyHash` or `knownAt`; it derives both from immutable registration history. The Brain package also has a stronger regression guard against exposing the low-level registered-hypothesis evaluator or its receipt as a shortcut.

### Not yet closed

There is still no supported end-to-end production composition path that takes the ledger-derived Desk registration and invokes the private deterministic FDR evaluator without weakening package boundaries. This is intentionally not hidden by declaring ADR-0021 complete.

The next safe step is to establish a deliberately supported composition/package dependency using the repository's normal package-manager/lockfile workflow, then enforce a single production path:

`verified Desk ledger -> ledger-derived family/receipt -> private deterministic registered-hypothesis/FDR evaluation`

After that, a final independent ADR-0021 red-team audit should decide closure. Calibration metrics should only be added where a real probability is emitted; the current deterministic Brain score must not be mislabeled as a probability merely to satisfy a metric checklist. ADR-0020 Memory remains sequenced after evaluation integrity is genuinely closed.

## Safety / authority

This milestone adds no broker command, MT5 authority, risk override, automatic champion promotion, LLM-generated actionable score, or real-money execution path.
