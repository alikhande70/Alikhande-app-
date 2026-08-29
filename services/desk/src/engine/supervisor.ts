import { createHash } from 'node:crypto';
import type { Dec, InstrumentSpec, RiskDecision, Side, SizingResult } from '@keel/core';
import * as D from '@keel/core';
import { evaluate, sizePosition } from '@keel/core';
import type { Logger } from 'pino';
import type { BrokerMarginResult, BrokerOrderRequest, BrokerPort } from '../broker/port.js';
import { supportsSafeRetry } from '../broker/port.js';
import type { LedgerEvent, OrderIntent, RiskDecisionRecord } from '../ledger/events.js';
import type { Ledger } from '../ledger/ledger.js';
import type { Projector } from '../ledger/projections.js';
import type { Clock } from '../sim/clock.js';
import { KeyedMutex } from './lock.js';
import { recordOrderEvent } from './record.js';
import type { DeskState } from './state.js';

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
  readonly onUnknown: (intentId: string, clientOrderId: string) => void;
  readonly onAnomaly?: (intentId: string, anomaly: D.Anomaly) => void;
}

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

  applyVenueEvent(intentId: string, event: D.OrderEvent): void {
    this.record(intentId, event);
  }

  async preview(
    cmd: SubmitCommand,
  ): Promise<{ risk: RiskDecision; sizing: SizingResult | undefined }> {
    const prepared = await this.prepare(cmd);
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

    const prepared = await this.prepare(cmd);
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
    this.record(cmd.intentId, { type: 'submit.started', at: clock.now() });

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
      result = {
        outcome: 'ambiguous',
        reason: `transport threw: ${err instanceof Error ? err.message : String(err)}`,
        at: clock.now(),
      };
    }

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
          accepted: true,
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

  private async prepare(cmd: SubmitCommand): Promise<
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
      }
  > {
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

    const riskAccount = sizing?.ok ? sizing.riskAtStop : undefined;
    const marginAccount = await this.marginInAccountCurrency(
      spec,
      volume,
      entry,
      cmd,
      account.currency,
      now,
    );

    const decision = evaluate(
      {
        spec,
        side: cmd.side,
        volume,
        requestedRiskBudget: riskAccount ?? D.dec('0.00'),
        ...(marginAccount === undefined ? {} : { marginRequiredAccount: marginAccount }),
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

  private async marginInAccountCurrency(
    spec: InstrumentSpec,
    volume: Dec,
    entry: Dec | undefined,
    cmd: SubmitCommand,
    accountCurrency: string,
    now: number,
  ): Promise<Dec | undefined> {
    if (entry === undefined) return undefined;

    const calculateMargin = this.deps.broker.calculateMargin;
    if (calculateMargin !== undefined) {
      let result: BrokerMarginResult;
      try {
        result = await calculateMargin.call(this.deps.broker, {
          canonical: spec.canonical,
          symbol: spec.symbol,
          side: cmd.side,
          kind: cmd.kind,
          volume,
          price: entry,
        });
      } catch (error) {
        this.deps.log.warn(
          {
            canonical: spec.canonical,
            err: error instanceof Error ? error.message : String(error),
          },
          'request-specific margin lookup failed; blocking as unknown',
        );
        return undefined;
      }
      if (result.status !== 'available') {
        this.deps.log.warn(
          { canonical: spec.canonical, reason: result.reason, certainty: result.certainty },
          'request-specific margin unavailable; blocking entry',
        );
        return undefined;
      }
      const age = now - result.asOf;
      if (!Number.isFinite(result.asOf) || age < 0 || age > this.deps.state.policy.maxQuoteAgeMs) {
        this.deps.log.warn(
          { canonical: spec.canonical, asOf: result.asOf, ageMs: age },
          'request-specific margin is stale or from the future; blocking entry',
        );
        return undefined;
      }
      return result.requiredAccountCurrency;
    }

    const quoteMargin = D.marginQuote(spec, volume, entry);
    if (quoteMargin === undefined) return undefined;
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
