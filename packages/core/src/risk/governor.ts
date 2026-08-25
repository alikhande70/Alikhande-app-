import type { InstrumentSpec } from '../market/instrument.js';
import type { Side } from '../market/sizing.js';
import type { Dec } from '../money/decimal.js';
import * as D from '../money/decimal.js';
import { sessionContext } from '../time/sessions.js';
import type { DrawdownReading } from './drawdown.js';
import type { RiskPolicy } from './policy.js';

/**
 * The Risk Governor.
 *
 * Every order path in the system passes through `evaluate`. It is pure, so the
 * mobile client can run the identical function for a live preview and get an
 * identical answer to the one the desk will enforce — a preview that can
 * disagree with enforcement is worse than no preview, because the operator
 * learns to ignore it.
 *
 * All rules are evaluated, never short-circuited: the operator should see
 * everything wrong at once rather than discovering problems one refusal at a
 * time under pressure.
 */

export type Verdict = 'pass' | 'warn' | 'block';

export interface RiskCheck {
  readonly rule: string;
  readonly verdict: Verdict;
  /** What was measured, already formatted for display. */
  readonly observed: string;
  /** The limit it was measured against. */
  readonly limit: string;
  readonly message: string;
}

export interface RiskDecision {
  readonly verdict: Verdict;
  readonly checks: readonly RiskCheck[];
  /** Populated when a rule requires a smaller size than requested. */
  readonly cappedVolume?: Dec;
  /** Populated when a rule requires a smaller risk budget than requested. */
  readonly cappedRiskBudget?: Dec;
  /** Snapshot of the policy version that produced this decision. */
  readonly policyVersion: number;
  readonly evaluatedAt: number;
}

export interface OpenPositionRisk {
  readonly canonical: string;
  readonly side: Side;
  readonly volume: Dec;
  /**
   * Risk to the stop in account currency. Undefined means the risk could not be
   * put on the aggregate scale — see `riskUnknownReason` for which kind of
   * "could not". Both block, but for different reasons and with different
   * remedies, so they must not read the same.
   */
  readonly riskAccount?: Dec;
  /**
   * Why `riskAccount` is absent.
   *
   * `no-stop` means the position genuinely has unbounded downside and needs a
   * stop attached. `cannot-value` means it has a stop but the desk could not
   * convert the loss into account currency — a data problem, not a risk one.
   * Telling an operator to "attach a stop" to a position that already has one
   * teaches them the warnings are wrong.
   */
  readonly riskUnknownReason?: 'no-stop' | 'cannot-value';
}

export interface AccountSnapshot {
  readonly currency: string;
  readonly balance: Dec;
  readonly equity: Dec;
  readonly marginUsed: Dec;
  readonly marginFree: Dec;
  readonly asOf: number;
  readonly source: 'broker' | 'derived';
}

export interface DayStats {
  /** Balance (or equity) at the last day boundary, for the daily-loss rule. */
  readonly dayOpenBalance: Dec;
  readonly tradesToday: number;
  readonly consecutiveLosses: number;
  /** When the most recent loss closed, for the cooldown rule. */
  readonly lastLossAt?: number;
}

export interface CalendarEvent {
  readonly at: number;
  readonly impact: 'low' | 'medium' | 'high';
  readonly title: string;
  /** Canonical instruments affected. Empty means "all". */
  readonly affects: readonly string[];
}

export interface RiskRequest {
  readonly spec: InstrumentSpec;
  readonly side: Side;
  readonly volume: Dec;
  /** Money at risk to the stop, in account currency. Undefined means no stop. */
  readonly riskAccount?: Dec;
  /** Requested risk budget, before any cap. */
  readonly requestedRiskBudget: Dec;
  readonly marginRequiredAccount: Dec;
  /** Current spread in price units, and the instrument's typical spread. */
  readonly spread?: Dec;
  readonly typicalSpread?: Dec;
  /** Source timestamp of the execution quote used to build this order. */
  readonly quoteAsOf?: number;
  readonly hasPreTradeNote: boolean;
  /** Materially identical intents already seen, with their timestamps. */
  readonly recentIdenticalIntents: readonly number[];
  /** Set when the operator has explicitly broken glass for this one intent. */
  readonly override?: { readonly reason: string; readonly authorisedAt: number };
}

export interface RiskContext {
  readonly policy: RiskPolicy;
  readonly account: AccountSnapshot;
  readonly openPositions: readonly OpenPositionRisk[];
  readonly day: DayStats;
  readonly drawdown: DrawdownReading;
  readonly calendar: readonly CalendarEvent[];
  readonly now: number;
  /** True when the desk currently holds a healthy broker connection. */
  readonly brokerConnected: boolean;
  /** Set while a guard lockout is in force. */
  readonly lockout?: { readonly until: number; readonly reason: string };
}

const pct = (v: Dec): string => `${D.toString(D.rescale(D.mul(v, D.dec(100)), 2, 'half-even'))}%`;

function check(
  rule: string,
  verdict: Verdict,
  observed: string,
  limit: string,
  message: string,
): RiskCheck {
  return { rule, verdict, observed, limit, message };
}

function fractionOfEquity(amount: Dec, equity: Dec): Dec {
  if (D.lte(equity, D.ZERO)) return D.ONE;
  return D.div(amount, equity, 6, 'half-even');
}

export function evaluate(req: RiskRequest, ctx: RiskContext): RiskDecision {
  const { policy, account } = ctx;
  const checks: RiskCheck[] = [];
  let cappedRiskBudget: Dec | undefined;

  // --- Hard gates: conditions under which nothing may be sent ---------------

  if (ctx.lockout !== undefined && ctx.now < ctx.lockout.until) {
    const mins = Math.ceil((ctx.lockout.until - ctx.now) / 60_000);
    checks.push(
      check(
        'lockout',
        'block',
        `locked (${ctx.lockout.reason})`,
        'no lockout',
        `Trading is locked for another ${mins} min: ${ctx.lockout.reason}.`,
      ),
    );
  }

  if (!ctx.brokerConnected) {
    checks.push(
      check(
        'broker-connection',
        'block',
        'disconnected',
        'connected',
        'No healthy broker connection. An order sent now has an unknowable outcome.',
      ),
    );
  }

  if (account.source !== 'broker') {
    checks.push(
      check(
        'account-truth',
        'block',
        account.source,
        'broker',
        'Account figures are not from the broker. Sizing cannot be trusted.',
      ),
    );
  }

  const accountAgeMs = ctx.now - account.asOf;
  if (accountAgeMs > 60_000) {
    checks.push(
      check(
        'account-freshness',
        'block',
        `${Math.round(accountAgeMs / 1000)}s old`,
        '60s',
        'Account state is stale. Equity may have moved; refusing to size against it.',
      ),
    );
  }

  // --- Instrument permission -----------------------------------------------

  if (!policy.allowedInstruments.includes(req.spec.canonical)) {
    checks.push(
      check(
        'instrument-allowlist',
        'block',
        req.spec.canonical,
        policy.allowedInstruments.join(', '),
        `${req.spec.canonical} is not on your traded list.`,
      ),
    );
  }

  const instCap = policy.instrumentMaxVolume[req.spec.canonical];
  if (instCap !== undefined && D.gt(req.volume, instCap)) {
    checks.push(
      check(
        'instrument-volume-cap',
        'block',
        `${D.toString(req.volume)} lots`,
        `${D.toString(instCap)} lots`,
        `Above your per-instrument size cap for ${req.spec.canonical}.`,
      ),
    );
  }

  // --- The stop --------------------------------------------------------------

  if (req.riskAccount === undefined) {
    checks.push(
      check(
        'stop-required',
        policy.requireStopLoss ? 'block' : 'warn',
        'no stop',
        'stop required',
        'No stop attached. Risk on this position is unbounded.',
      ),
    );
  }

  if (policy.requirePreTradeNote && !req.hasPreTradeNote) {
    checks.push(
      check(
        'pre-trade-note',
        'block',
        'missing',
        'required',
        'Write why you are taking this trade before it goes out.',
      ),
    );
  }

  // --- Sizing limits ---------------------------------------------------------

  const risk = req.riskAccount;
  if (risk !== undefined) {
    const riskPct = fractionOfEquity(risk, account.equity);
    if (D.gt(riskPct, policy.maxRiskPctPerTrade)) {
      checks.push(
        check(
          'per-trade-risk',
          'block',
          pct(riskPct),
          pct(policy.maxRiskPctPerTrade),
          `Risk on this trade exceeds your per-trade ceiling.`,
        ),
      );
      cappedRiskBudget = D.rescale(D.mul(account.equity, policy.maxRiskPctPerTrade), 2, 'down');
    } else {
      checks.push(
        check(
          'per-trade-risk',
          'pass',
          pct(riskPct),
          pct(policy.maxRiskPctPerTrade),
          `Risking ${D.toString(risk)} ${account.currency}.`,
        ),
      );
    }

    // Aggregate open risk. A position with no stop has *unbounded* downside;
    // there is no number to add. Substituting margin, or zero, would produce a
    // total that reads as safe and is not — so the rule refuses instead.
    const unvalued = ctx.openPositions.filter((p) => p.riskAccount === undefined);
    const stopless = unvalued.filter((p) => p.riskUnknownReason !== 'cannot-value');
    const unpriceable = unvalued.filter((p) => p.riskUnknownReason === 'cannot-value');
    if (stopless.length > 0) {
      checks.push(
        check(
          'aggregate-open-risk',
          'block',
          `${stopless.length} position(s) without a stop`,
          pct(policy.maxOpenRiskPct),
          `${stopless.map((p) => p.canonical).join(', ')} has no stop, so total open risk is ` +
            'unbounded and cannot be compared to a cap. Protect it before adding exposure.',
        ),
      );
    } else if (unpriceable.length > 0) {
      checks.push(
        check(
          'aggregate-open-risk',
          'block',
          `${unpriceable.length} position(s) whose risk cannot be valued`,
          pct(policy.maxOpenRiskPct),
          `${unpriceable.map((p) => p.canonical).join(', ')} has a stop, but the desk cannot ` +
            'convert its risk into account currency — an FX rate is missing or stale. This is a ' +
            'data problem, not an unprotected position: do not go attaching stops that are ' +
            'already there.',
        ),
      );
    } else {
      const openRisk = D.sum(ctx.openPositions.map((p) => p.riskAccount ?? D.ZERO));
      const totalRisk = D.add(openRisk, risk);
      const totalPct = fractionOfEquity(totalRisk, account.equity);
      checks.push(
        check(
          'aggregate-open-risk',
          D.gt(totalPct, policy.maxOpenRiskPct) ? 'block' : 'pass',
          pct(totalPct),
          pct(policy.maxOpenRiskPct),
          D.gt(totalPct, policy.maxOpenRiskPct)
            ? `Total risk across ${ctx.openPositions.length} open position(s) plus this one is over your cap.`
            : 'Within aggregate risk.',
        ),
      );
    }

    // Correlation groups: two "different" trades that are one bet.
    for (const group of policy.correlationGroups) {
      if (!group.members.includes(req.spec.canonical)) continue;
      const groupOpen = ctx.openPositions.filter((p) => group.members.includes(p.canonical));
      const groupRisk = D.add(D.sum(groupOpen.map((p) => p.riskAccount ?? D.ZERO)), risk);
      const groupPct = fractionOfEquity(groupRisk, account.equity);
      if (D.gt(groupPct, group.maxRiskPct)) {
        checks.push(
          check(
            `correlation:${group.id}`,
            'block',
            pct(groupPct),
            pct(group.maxRiskPct),
            groupOpen.length > 0
              ? `${group.label}: this and ${groupOpen.length} open position(s) are one correlated bet.`
              : `${group.label}: over the group cap on its own.`,
          ),
        );
      }
    }
  }

  // --- Daily loss and drawdown ----------------------------------------------

  const dayLoss = D.sub(ctx.day.dayOpenBalance, account.equity);
  const dayLossPct = fractionOfEquity(dayLoss, ctx.day.dayOpenBalance);
  if (D.gt(dayLoss, D.ZERO) && D.gte(dayLossPct, policy.maxDailyLossPct)) {
    checks.push(
      check(
        'daily-loss-limit',
        'block',
        pct(dayLossPct),
        pct(policy.maxDailyLossPct),
        'Daily loss limit reached. No more entries today.',
      ),
    );
  } else if (D.gt(dayLoss, D.ZERO)) {
    const used = D.div(dayLossPct, policy.maxDailyLossPct, 4, 'half-even');
    checks.push(
      check(
        'daily-loss-limit',
        D.gte(used, D.dec('0.75')) ? 'warn' : 'pass',
        pct(dayLossPct),
        pct(policy.maxDailyLossPct),
        `Down ${D.toString(dayLoss)} ${account.currency} today.`,
      ),
    );
  }

  if (ctx.drawdown.status === 'breached') {
    checks.push(
      check(
        'drawdown',
        'block',
        'breached',
        D.toString(ctx.drawdown.state.floor),
        ctx.drawdown.explain,
      ),
    );
  } else if (ctx.drawdown.status === 'warning') {
    checks.push(
      check(
        'drawdown',
        'warn',
        D.toString(ctx.drawdown.buffer),
        D.toString(ctx.drawdown.state.floor),
        ctx.drawdown.explain,
      ),
    );
  }

  // A trade whose stop is beyond the drawdown floor is a trade that can end the
  // account. The rule caps risk at the remaining buffer rather than refusing,
  // because a smaller position is usually what the operator actually wants.
  if (risk !== undefined && ctx.drawdown.status !== 'not-applicable') {
    const buffer = ctx.drawdown.buffer;
    if (D.gt(risk, buffer) && D.gt(buffer, D.ZERO)) {
      checks.push(
        check(
          'drawdown-headroom',
          'block',
          D.toString(risk),
          D.toString(buffer),
          `This trade risks more than the ${D.toString(buffer)} ${account.currency} of drawdown buffer left. ` +
            'Losing it would end the account, not just the day.',
        ),
      );
      const capped = D.rescale(buffer, 2, 'down');
      cappedRiskBudget = cappedRiskBudget === undefined ? capped : D.min(cappedRiskBudget, capped);
    }
  }

  // --- Behavioural limits ----------------------------------------------------

  if (ctx.day.tradesToday >= policy.maxTradesPerDay) {
    checks.push(
      check(
        'trades-per-day',
        'block',
        String(ctx.day.tradesToday),
        String(policy.maxTradesPerDay),
        'Daily trade count reached. This limit exists to stop revenge trading.',
      ),
    );
  }

  if (ctx.openPositions.length >= policy.maxConcurrentPositions) {
    checks.push(
      check(
        'concurrent-positions',
        'block',
        String(ctx.openPositions.length),
        String(policy.maxConcurrentPositions),
        'Already at your maximum number of open positions.',
      ),
    );
  }

  if (ctx.day.consecutiveLosses >= policy.lossStreakLimit && ctx.day.lastLossAt !== undefined) {
    const until = ctx.day.lastLossAt + policy.cooldownMinutes * 60_000;
    if (ctx.now < until) {
      const mins = Math.ceil((until - ctx.now) / 60_000);
      checks.push(
        check(
          'loss-streak-cooldown',
          'block',
          `${ctx.day.consecutiveLosses} losses`,
          `${policy.lossStreakLimit} losses`,
          `${ctx.day.consecutiveLosses} losses in a row. Cooling down for another ${mins} min.`,
        ),
      );
    }
  }

  // --- Market conditions -----------------------------------------------------

  const session = sessionContext(ctx.now, req.spec.venueTimeZone);
  if (policy.sessions.requireMarketOpen && !session.marketOpen) {
    checks.push(check('market-open', 'block', 'closed', 'open', 'The market is closed.'));
  }
  if (policy.sessions.allowed.length > 0 && session.marketOpen) {
    const inAllowed = session.active.some((s) => policy.sessions.allowed.includes(s));
    if (!inAllowed) {
      checks.push(
        check(
          'session-window',
          'block',
          session.active.length > 0 ? session.active.join('+') : 'no session',
          policy.sessions.allowed.join('+'),
          'Outside the sessions you trade.',
        ),
      );
    }
  }
  if (policy.sessions.blockRollover && session.inRollover) {
    checks.push(
      check(
        'rollover',
        'block',
        'in rollover',
        'outside rollover',
        'Daily rollover: spreads widen sharply and fills are unreliable.',
      ),
    );
  }

  if (policy.news.enabled) {
    const rank = { low: 0, medium: 1, high: 2 };
    for (const ev of ctx.calendar) {
      if (rank[ev.impact] < rank[policy.news.minImpact]) continue;
      if (ev.affects.length > 0 && !ev.affects.includes(req.spec.canonical)) continue;
      const from = ev.at - policy.news.minutesBefore * 60_000;
      const to = ev.at + policy.news.minutesAfter * 60_000;
      if (ctx.now >= from && ctx.now <= to) {
        const delta = Math.round((ev.at - ctx.now) / 60_000);
        checks.push(
          check(
            'news-blackout',
            'block',
            ev.title,
            `${policy.news.minutesBefore}m before / ${policy.news.minutesAfter}m after`,
            `${ev.title} ${delta >= 0 ? `in ${delta} min` : `${-delta} min ago`}.`,
          ),
        );
      }
    }
  }

  if (
    req.spread !== undefined &&
    req.typicalSpread !== undefined &&
    D.gt(req.typicalSpread, D.ZERO)
  ) {
    const multiple = D.div(req.spread, req.typicalSpread, 2, 'half-even');
    if (D.gt(multiple, policy.maxSpreadMultiple)) {
      checks.push(
        check(
          'spread-sanity',
          'block',
          `${D.toString(multiple)}x typical`,
          `${D.toString(policy.maxSpreadMultiple)}x`,
          'Spread is abnormally wide. Entering here pays a cost the setup did not budget for.',
        ),
      );
    }
  }

  if (req.quoteAsOf !== undefined) {
    const age = ctx.now - req.quoteAsOf;
    if (age > policy.maxQuoteAgeMs) {
      checks.push(
        check(
          'quote-freshness',
          'block',
          `${age}ms old`,
          `${policy.maxQuoteAgeMs}ms`,
          'The price this order was built from is stale.',
        ),
      );
    }
  }

  // --- Margin ---------------------------------------------------------------

  const marginAfter = D.sub(account.marginFree, req.marginRequiredAccount);
  const marginAfterPct = fractionOfEquity(marginAfter, account.equity);
  if (D.lt(marginAfterPct, policy.minFreeMarginPct)) {
    checks.push(
      check(
        'free-margin',
        'block',
        pct(marginAfterPct),
        pct(policy.minFreeMarginPct),
        'Not enough free margin left after this trade to survive normal adverse movement.',
      ),
    );
  }

  // --- Double-tap guard ------------------------------------------------------

  const recentDup = req.recentIdenticalIntents.filter(
    (t) => ctx.now - t <= policy.duplicateIntentWindowMs,
  );
  if (recentDup.length > 0) {
    checks.push(
      check(
        'duplicate-intent',
        'block',
        `${recentDup.length} identical intent(s) in the last ${policy.duplicateIntentWindowMs / 1000}s`,
        'none',
        'A materially identical order was just placed. If you meant to add, change something.',
      ),
    );
  }

  return finalise(checks, req, policy, ctx.now, cappedRiskBudget);
}

/**
 * Rules an override may waive, and rules it may not.
 *
 * The unwaivable set is the point of the whole system: these are the conditions
 * under which the operator's own judgement is the *least* reliable, or under
 * which the system genuinely cannot compute a safe answer.
 */
export const UNWAIVABLE_RULES: ReadonlySet<string> = new Set([
  'broker-connection',
  'account-truth',
  'account-freshness',
  'quote-freshness',
  'drawdown',
  'drawdown-headroom',
  'daily-loss-limit',
  'duplicate-intent',
]);

function finalise(
  checks: RiskCheck[],
  req: RiskRequest,
  policy: RiskPolicy,
  now: number,
  cappedRiskBudget: Dec | undefined,
): RiskDecision {
  let effective = checks;
  if (req.override !== undefined) {
    effective = checks.map((c) => {
      if (c.verdict !== 'block') return c;
      if (UNWAIVABLE_RULES.has(c.rule)) return c;
      return {
        ...c,
        verdict: 'warn' as const,
        message: `${c.message} [OVERRIDDEN: ${req.override?.reason ?? ''}]`,
      };
    });
  }

  const blocked = effective.some((c) => c.verdict === 'block');
  const warned = effective.some((c) => c.verdict === 'warn');
  const verdict: Verdict = blocked ? 'block' : warned ? 'warn' : 'pass';

  return {
    verdict,
    checks: effective,
    policyVersion: policy.version,
    evaluatedAt: now,
    ...(cappedRiskBudget !== undefined ? { cappedRiskBudget } : {}),
  };
}

/** One-line summary for a notification or a log entry. */
export function summariseRiskDecision(decision: RiskDecision): string {
  const blockers = decision.checks.filter((c) => c.verdict === 'block');
  if (blockers.length === 0) {
    const warns = decision.checks.filter((c) => c.verdict === 'warn');
    return warns.length === 0
      ? 'All risk checks passed.'
      : `Passed with ${warns.length} warning(s).`;
  }
  return `Blocked by ${blockers.map((b) => b.rule).join(', ')}.`;
}
