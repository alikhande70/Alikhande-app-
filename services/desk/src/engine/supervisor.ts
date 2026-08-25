import { createHash } from 'node:crypto';
import type { Dec, InstrumentSpec, RiskDecision, Side, SizingResult } from '@keel/core';
import * as D from '@keel/core';
import { evaluate, sizePosition } from '@keel/core';
import type { Logger } from 'pino';
import type { BrokerOrderRequest, BrokerPort } from '../broker/port.js';
import { supportsSafeRetry } from '../broker/port.js';
import type { LedgerEvent, OrderIntent, RiskDecisionRecord } from '../ledger/events.js';
import type { Ledger } from '../ledger/ledger.js';
import type { Projector } from '../ledger/projections.js';
import type { Clock } from '../sim/clock.js';
import { KeyedMutex } from './lock.js';
import { recordOrderEvent } from './record.js';
import type { DeskState } from './state.js';

/**
 * The execution supervisor.
 *
 * The one path from a human decision to a venue, and the place where the
 * system's central promise is kept: it never claims to know something it does
 * not. The ordering below is deliberate and is the whole design:
 *
 *   1. hold the per-intent lock          (two taps cannot race)
 *   2. check idempotency in the ledger   (a retry returns the first outcome)
 *   3. evaluate risk                     (server-side, unbypassable)
 *   4. derive size from the venue spec   (never trust a client-computed size)
 *   5. fsync the intent                  (evidence exists before transmission)
 *   6. transmit
 *   7. classify honestly                 (timeout is UNKNOWN, never REJECTED)
 *
 * Step 5 before step 6 is the property that makes a power cut survivable.
 */

export interface SubmitCommand {
  readonly intentId: string;
  readonly canonical: string;
  readonly side: Side;
  readonly kind: 'market' | 'limit' | 'stop' | 'stop_limit';
  readonly timeInForce: string;
  readonly price?: Dec;
  readonly stopPrice?: Dec;
  readonly takeProfitPrice?: Dec;
  readonly riskPct?: Dec;
  readonly riskAmount?: Dec;
  readonly explicitVolume?: Dec;
  readonly acknowledgeManualSize: boolean;
  readonly preTradeNote: string;
  readonly tags: readonly string[];
  readonly referenceQuote?: { bid: Dec; ask: Dec; asOf: number };
  readonly maxSlippage?: Dec;
  readonly override?: { reason: string };
}

export interface SubmitOutcome {
  readonly intentId: string;
  readonly accepted: boolean;
  readonly risk: RiskDecision;
  readonly sizing?: SizingResult;
  readonly deduplicated: boolean;
  readonly problem?: {
    code: string;
    title: string;
    detail: string;
    retryable: boolean;
    outcomeUnknown: boolean;
  };
}

export interface SupervisorDeps {
  readonly ledger: Ledger;
  readonly projector: Projector;
  readonly state: DeskState;
  readonly broker: BrokerPort;
  readonly clock: Clock;
  readonly log: Logger;
  /** Called whenever an intent reaches UNKNOWN, to start resolution. */
  readonly onUnknown: (intentId: string, clientOrderId: string) => void;
  /** Called for each anomaly, so alerts and divergences can be raised. */
  readonly onAnomaly?: (intentId: string, anomaly: D.Anomaly) => void;
}

/**
 * The venue-visible idempotency key, derived deterministically from the intent
 * id so a retry of the same human decision carries the same key.
 *
 * It must be short: MT5 order comments are 31 characters, and several venues
 * cap client ids well below a UUID's length. Truncating the id itself is not an
 * option — two intents whose ids share a prefix would collide, and a collision
 * here is silent and expensive: the venue treats the second, genuinely
 * different, trade as a duplicate of the first and never places it. The
 * operator sees an acknowledgement for a trade that does not exist.
 *
 * So the key is a hash, not a prefix. 80 bits of SHA-256 in base32 gives a
 * collision probability below 1 in 10^12 across a lifetime of orders, in 21
 * characters including the prefix.
 */
export function clientOrderIdFor(intentId: string): string {
  const digest = createHash('sha256').update(intentId).digest();
  return `k-${base32(digest.subarray(0, 10))}`;
}

const BASE32_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export class ExecutionSupervisor {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly deps: SupervisorDeps) {}

  /**
   * The one route an order event takes into the ledger.
   *
   * Applies it, records it together with any anomalies atomically, and
   * escalates. Nothing in this service should append an `order.event` directly.
   */
  private record(intentId: string, event: D.OrderEvent): void {
    recordOrderEvent(
      {
        ledger: this.deps.ledger,
        projector: this.deps.projector,
        log: this.deps.log,
        ...(this.deps.onAnomaly !== undefined ? { onAnomaly: this.deps.onAnomaly } : {}),
      },
      intentId,
      event,
    );
  }

  /**
   * Apply an event that arrived from the venue's own stream — a fill, an order
   * update. Public because the broker wiring needs it, and because routing it
   * anywhere else would recreate the defect this exists to prevent.
   */
  applyVenueEvent(intentId: string, event: D.OrderEvent): void {
    this.record(intentId, event);
  }

  /**
   * Evaluate risk and sizing without sending anything.
   * Shares every line of logic with `submit`, so a preview can never disagree
   * with what enforcement will do.
   */
  preview(cmd: SubmitCommand): { risk: RiskDecision; sizing: SizingResult | undefined } {
    const prepared = this.prepare(cmd);
    if ('failure' in prepared) {
      return { risk: prepared.risk, sizing: prepared.sizing };
    }
    return { risk: prepared.risk, sizing: prepared.sizing };
  }

  async submit(cmd: SubmitCommand): Promise<SubmitOutcome> {
    return this.mutex.run(cmd.intentId, () => this.submitLocked(cmd));
  }

  private async submitLocked(cmd: SubmitCommand): Promise<SubmitOutcome> {
    const { ledger, projector, state, broker, clock, log } = this.deps;

    // --- 2. Idempotency ----------------------------------------------------
    // A retry of the same human decision must never produce a second order.
    projector.catchUp();
    if (state.hasIntent(cmd.intentId)) {
      const existing = projector.loadOrderRecord(cmd.intentId);
      log.info(
        { intentId: cmd.intentId, state: existing?.state },
        'duplicate intent; returning prior outcome',
      );
      return {
        intentId: cmd.intentId,
        accepted: existing !== undefined && existing.state !== 'FAILED_LOCAL',
        risk: emptyPass(clock.now(), state.policy.version),
        deduplicated: true,
      };
    }

    // --- 3 & 4. Risk and sizing -------------------------------------------
    const prepared = this.prepare(cmd);
    if ('failure' in prepared) {
      ledger.append({
        kind: 'intent.refused',
        intentId: cmd.intentId,
        risk: toRiskRecord(prepared.risk),
      });
      projector.catchUp();
      return {
        intentId: cmd.intentId,
        accepted: false,
        risk: prepared.risk,
        ...(prepared.sizing !== undefined ? { sizing: prepared.sizing } : {}),
        deduplicated: false,
        problem: prepared.failure,
      };
    }

    const { spec, volume, risk, sizing } = prepared;
    const clientOrderId = clientOrderIdFor(cmd.intentId);

    const intent: OrderIntent = {
      intentId: cmd.intentId,
      canonical: cmd.canonical,
      symbol: spec.symbol,
      side: cmd.side,
      kind: cmd.kind,
      timeInForce: cmd.timeInForce,
      volume: D.Decimal.toString(volume),
      preTradeNote: cmd.preTradeNote,
      tags: cmd.tags,
      clientOrderId,
      ...(cmd.price !== undefined ? { limitPrice: D.Decimal.toString(cmd.price) } : {}),
      ...(cmd.stopPrice !== undefined && cmd.kind !== 'market'
        ? { stopPrice: D.Decimal.toString(cmd.stopPrice) }
        : {}),
      ...(cmd.stopPrice !== undefined ? { attachedStop: D.Decimal.toString(cmd.stopPrice) } : {}),
      ...(cmd.takeProfitPrice !== undefined
        ? { attachedTakeProfit: D.Decimal.toString(cmd.takeProfitPrice) }
        : {}),
      ...(sizing?.ok ? { riskAccount: D.Decimal.toString(sizing.riskAtStop) } : {}),
      ...(cmd.referenceQuote !== undefined
        ? {
            referenceQuote: {
              bid: D.Decimal.toString(cmd.referenceQuote.bid),
              ask: D.Decimal.toString(cmd.referenceQuote.ask),
              asOf: cmd.referenceQuote.asOf,
            },
          }
        : {}),
      ...(cmd.maxSlippage !== undefined
        ? { maxSlippage: D.Decimal.toString(cmd.maxSlippage) }
        : {}),
    };

    // --- 5. Durability before transmission --------------------------------
    // Synchronous and fsynced. When this returns, evidence that we were about
    // to send exists on disk, whatever happens next.
    const pre: LedgerEvent[] = [{ kind: 'intent.created', intent, risk: toRiskRecord(risk) }];
    if (cmd.override !== undefined) {
      pre.push({
        kind: 'override.used',
        intentId: cmd.intentId,
        reason: cmd.override.reason,
        waivedRules: risk.checks.filter((c) => c.message.includes('OVERRIDDEN')).map((c) => c.rule),
        authorisedAt: clock.now(),
      });
    }
    ledger.appendAll(pre);
    projector.catchUp();
    // Separate from the batch above so it goes through the one route that also
    // records and escalates anomalies.
    this.record(cmd.intentId, { type: 'submit.started', at: clock.now() });

    // --- 6. Transmit -------------------------------------------------------
    const brokerReq: BrokerOrderRequest = {
      clientOrderId,
      canonical: cmd.canonical,
      symbol: spec.symbol,
      side: cmd.side,
      kind: cmd.kind,
      volume,
      timeInForce: cmd.timeInForce,
      ...(cmd.price !== undefined ? { limitPrice: cmd.price } : {}),
      ...(cmd.kind === 'stop' || cmd.kind === 'stop_limit'
        ? cmd.price !== undefined
          ? { stopTriggerPrice: cmd.price }
          : {}
        : {}),
      ...(cmd.stopPrice !== undefined ? { stopLoss: cmd.stopPrice } : {}),
      ...(cmd.takeProfitPrice !== undefined ? { takeProfit: cmd.takeProfitPrice } : {}),
      ...(cmd.maxSlippage !== undefined ? { maxSlippage: cmd.maxSlippage } : {}),
    };

    let result: Awaited<ReturnType<BrokerPort['placeOrder']>>;
    try {
      result = await broker.placeOrder(brokerReq);
    } catch (err) {
      // A thrown error tells us nothing about whether the venue acted. The only
      // honest classification is ambiguous.
      result = {
        outcome: 'ambiguous',
        reason: `transport threw: ${err instanceof Error ? err.message : String(err)}`,
        at: clock.now(),
      };
    }

    // --- 7. Classify -------------------------------------------------------
    return this.recordSubmitResult(cmd.intentId, clientOrderId, result, risk, sizing);
  }

  private recordSubmitResult(
    intentId: string,
    clientOrderId: string,
    result: Awaited<ReturnType<BrokerPort['placeOrder']>>,
    risk: RiskDecision,
    sizing: SizingResult | undefined,
  ): SubmitOutcome {
    const { projector, broker, log } = this.deps;

    switch (result.outcome) {
      case 'acked': {
        this.record(intentId, {
          type: 'submit.acked',
          at: result.at,
          venueOrderId: result.venueOrderId,
          ...(result.venueStatus !== undefined ? { venueStatus: result.venueStatus } : {}),
        });

        // The acknowledgement is itself a venue observation. When it reports
        // fills, that information must not be dropped on the floor: some venues
        // return the resulting deal inline and never send a separate fill
        // event, and a venue deduplicating on client order id returns the
        // *original* order's state, which is a discrepancy worth surfacing.
        //
        // When the fill event already arrived (the normal case for a streaming
        // venue) local state matches and this is a no-op. When it did not, the
        // state machine adopts the venue's figure and raises an anomaly —
        // which is exactly right, because something did go wrong.
        if (D.Decimal.gt(result.filledQty, D.Decimal.ZERO)) {
          const local = projector.loadOrderRecord(intentId);
          if (local !== undefined && D.Decimal.gt(result.filledQty, local.filledQty)) {
            this.record(intentId, {
              type: 'venue.observed',
              at: result.at,
              venueState: result.state,
              filledQty: result.filledQty,
            });
            log.warn(
              {
                intentId,
                venueFilled: D.Decimal.toString(result.filledQty),
                localFilled: D.Decimal.toString(local.filledQty),
                venueStatus: result.venueStatus,
              },
              'acknowledgement reported fills we had not recorded',
            );
          }
        }
        return {
          intentId,
          accepted: true,
          risk,
          ...(sizing !== undefined ? { sizing } : {}),
          deduplicated: false,
        };
      }

      case 'rejected': {
        this.record(intentId, {
          type: 'submit.rejected',
          at: result.at,
          reason: `${result.code ?? 'REJECTED'}: ${result.reason}`,
        });
        return {
          intentId,
          accepted: false,
          risk,
          ...(sizing !== undefined ? { sizing } : {}),
          deduplicated: false,
          problem: {
            code: result.code ?? 'BROKER_REJECTED',
            title: 'The broker rejected this order',
            detail: result.reason,
            // Retryable only in the sense that the operator may fix and resend
            // as a *new* intent; this intent id is finished.
            retryable: false,
            outcomeUnknown: false,
          },
        };
      }

      case 'ambiguous': {
        this.record(intentId, {
          type: 'submit.ambiguous',
          at: result.at,
          reason: result.reason,
        });
        const canResolve = supportsSafeRetry(broker.capabilities);
        log.warn({ intentId, reason: result.reason, canResolve }, 'submit outcome unknown');
        if (canResolve) this.deps.onUnknown(intentId, clientOrderId);
        return {
          intentId,
          accepted: true, // the desk owns it and will pursue it
          risk,
          ...(sizing !== undefined ? { sizing } : {}),
          deduplicated: false,
          problem: {
            code: 'OUTCOME_UNKNOWN',
            title: 'Outcome unknown',
            detail: canResolve
              ? `${result.reason}. The desk is querying the broker by client order id. Do not resend.`
              : `${result.reason}. This broker cannot be searched by client order id, so this must be ` +
                'resolved manually in the broker terminal. Do not resend.',
            retryable: false,
            outcomeUnknown: true,
          },
        };
      }
    }
  }

  /**
   * Everything that happens before transmission: instrument lookup, sizing, and
   * the risk evaluation. Pure with respect to the ledger, so `preview` and
   * `submit` cannot diverge.
   */
  private prepare(cmd: SubmitCommand):
    | { spec: InstrumentSpec; volume: Dec; risk: RiskDecision; sizing: SizingResult | undefined }
    | {
        failure: {
          code: string;
          title: string;
          detail: string;
          retryable: boolean;
          outcomeUnknown: boolean;
        };
        risk: RiskDecision;
        sizing: SizingResult | undefined;
      } {
    const { state, clock, broker } = this.deps;
    const now = clock.now();
    const policy = state.policy;

    const spec = state.getInstrument(cmd.canonical);
    if (spec === undefined) {
      return {
        failure: {
          code: 'UNKNOWN_INSTRUMENT',
          title: 'Instrument not available',
          detail: `No venue specification for ${cmd.canonical}. The desk will not guess one.`,
          retryable: true,
          outcomeUnknown: false,
        },
        risk: blockedDecision(now, policy.version, 'instrument-spec', 'missing'),
        sizing: undefined,
      };
    }

    const account = state.getAccount();
    if (account === undefined) {
      return {
        failure: {
          code: 'NO_ACCOUNT',
          title: 'No account snapshot',
          detail: 'The desk has not received account state from the broker yet.',
          retryable: true,
          outcomeUnknown: false,
        },
        risk: blockedDecision(now, policy.version, 'account-truth', 'missing'),
        sizing: undefined,
      };
    }

    const quote = state.getExecutionQuote(cmd.canonical);
    const entry =
      cmd.kind === 'market'
        ? quote === undefined
          ? undefined
          : cmd.side === 'buy'
            ? quote.ask
            : quote.bid
        : cmd.price;

    // --- Sizing ------------------------------------------------------------
    let volume: Dec | undefined;
    let sizing: SizingResult | undefined;

    if (cmd.explicitVolume !== undefined && cmd.acknowledgeManualSize) {
      volume = cmd.explicitVolume;
    } else if (cmd.explicitVolume !== undefined) {
      return {
        failure: {
          code: 'MANUAL_SIZE_NOT_ACKNOWLEDGED',
          title: 'Manual size needs an explicit acknowledgement',
          detail:
            'An explicit volume bypasses risk-derived sizing. Set acknowledgeManualSize to confirm ' +
            'you intend that.',
          retryable: false,
          outcomeUnknown: false,
        },
        risk: blockedDecision(now, policy.version, 'manual-size', 'unacknowledged'),
        sizing: undefined,
      };
    } else {
      if (entry === undefined || cmd.stopPrice === undefined) {
        return {
          failure: {
            code: 'CANNOT_SIZE',
            title: 'Not enough information to size this order',
            detail:
              entry === undefined
                ? 'No executable price is available for this instrument.'
                : 'Risk-derived sizing needs a stop price.',
            retryable: entry === undefined,
            outcomeUnknown: false,
          },
          risk: blockedDecision(now, policy.version, 'sizing', 'insufficient inputs'),
          sizing: undefined,
        };
      }
      const budget =
        cmd.riskAmount ??
        D.Decimal.rescale(
          D.Decimal.mul(account.equity, cmd.riskPct ?? policy.defaultRiskPct),
          2,
          'down',
        );
      sizing = sizePosition({
        spec,
        accountCurrency: account.currency,
        riskBudget: budget,
        entry,
        stop: cmd.stopPrice,
        side: cmd.side,
        fx: state.fxBook,
        now,
        maxQuoteAgeMs: policy.maxQuoteAgeMs * 20,
        ...(quote !== undefined ? { market: cmd.side === 'buy' ? quote.ask : quote.bid } : {}),
        ...(cmd.takeProfitPrice !== undefined ? { target: cmd.takeProfitPrice } : {}),
      });
      if (!sizing.ok) {
        return {
          failure: {
            code: sizing.code,
            title: 'Cannot size this order',
            detail: sizing.detail,
            retryable: sizing.code === 'CONVERSION_UNAVAILABLE' || sizing.code === 'SPEC_STALE',
            outcomeUnknown: false,
          },
          risk: blockedDecision(now, policy.version, 'sizing', sizing.code),
          sizing,
        };
      }
      volume = sizing.volume;
    }

    // --- Risk --------------------------------------------------------------
    const riskAccount = sizing?.ok ? sizing.riskAtStop : undefined;
    const marginAccount = this.marginInAccountCurrency(spec, volume, entry, account.currency, now);

    const decision = evaluate(
      {
        spec,
        side: cmd.side,
        volume,
        requestedRiskBudget: riskAccount ?? D.dec('0.00'),
        marginRequiredAccount: marginAccount ?? D.dec('0.00'),
        hasPreTradeNote: cmd.preTradeNote.trim().length > 0,
        recentIdenticalIntents: state.recentIdenticalIntents(
          cmd.canonical,
          cmd.side,
          volume,
          policy.duplicateIntentWindowMs,
        ),
        ...(riskAccount !== undefined ? { riskAccount } : {}),
        ...(quote !== undefined
          ? {
              spread: D.Decimal.sub(quote.ask, quote.bid),
              quoteAsOf: quote.asOf,
            }
          : {}),
        ...(state.getTypicalSpread(cmd.canonical) !== undefined
          ? { typicalSpread: state.getTypicalSpread(cmd.canonical) as Dec }
          : {}),
        ...(cmd.override !== undefined
          ? { override: { reason: cmd.override.reason, authorisedAt: now } }
          : {}),
      },
      {
        policy,
        account,
        openPositions: state.openPositionRisks(),
        day: state.dayStats(),
        drawdown: state.currentDrawdown(),
        calendar: [],
        now,
        brokerConnected: broker.isConnected(),
        ...(state.lockout() !== undefined
          ? { lockout: state.lockout() as { until: number; reason: string } }
          : {}),
      },
    );

    if (decision.verdict === 'block') {
      const blockers = decision.checks.filter((c) => c.verdict === 'block');
      return {
        failure: {
          code: 'RISK_BLOCKED',
          title: 'Blocked by your own rules',
          detail: blockers.map((b) => `${b.rule}: ${b.message}`).join(' '),
          retryable: false,
          outcomeUnknown: false,
        },
        risk: decision,
        sizing,
      };
    }

    return { spec, volume, risk: decision, sizing };
  }

  private marginInAccountCurrency(
    spec: InstrumentSpec,
    volume: Dec,
    entry: Dec | undefined,
    accountCurrency: string,
    now: number,
  ): Dec | undefined {
    if (entry === undefined) return undefined;
    const quoteMargin = D.marginQuote(spec, volume, entry);
    const conv = this.deps.state.fxBook.convert({
      amount: quoteMargin,
      from: spec.quote,
      to: accountCurrency,
      basis: 'worst-case',
      now,
      maxAgeMs: 60_000,
    });
    return conv.ok ? D.Decimal.rescale(conv.amount, 2, 'ceil') : undefined;
  }
}

function toRiskRecord(d: RiskDecision): RiskDecisionRecord {
  return {
    verdict: d.verdict,
    checks: d.checks.map((c) => ({
      rule: c.rule,
      verdict: c.verdict,
      observed: c.observed,
      limit: c.limit,
      message: c.message,
    })),
    policyVersion: d.policyVersion,
    evaluatedAt: d.evaluatedAt,
  };
}

function emptyPass(now: number, policyVersion: number): RiskDecision {
  return { verdict: 'pass', checks: [], policyVersion, evaluatedAt: now };
}

function blockedDecision(
  now: number,
  policyVersion: number,
  rule: string,
  observed: string,
): RiskDecision {
  return {
    verdict: 'block',
    checks: [
      {
        rule,
        verdict: 'block',
        observed,
        limit: 'required',
        message: `${rule} prevented this order from being prepared.`,
      },
    ],
    policyVersion,
    evaluatedAt: now,
  };
}
