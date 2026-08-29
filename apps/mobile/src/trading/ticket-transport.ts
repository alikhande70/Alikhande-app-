import type { ClientResult, DeskClient } from '../api/client.js';

export interface TicketPreview {
  readonly risk: {
    readonly verdict: 'pass' | 'warn' | 'block';
    readonly checks: readonly {
      readonly rule: string;
      readonly verdict: string;
      readonly observed: string;
      readonly limit: string;
      readonly message: string;
    }[];
  };
  readonly sizing?:
    | {
        readonly ok: true;
        readonly volume: string;
        readonly riskAtStop: string;
        readonly budgetUtilisation: string;
        readonly marginQuote: string;
        readonly rewardToRisk?: string;
        readonly valuationMethod: string;
        readonly crossCheckDivergencePct?: string;
      }
    | {
        readonly ok: false;
        readonly code: string;
        readonly detail: string;
        readonly venueBound?: string;
        readonly riskAtVenueBound?: string;
      };
}

export interface TicketOrderInput {
  readonly intentId: string;
  readonly canonical: string;
  readonly side: 'buy' | 'sell';
  readonly stopPrice: string;
  readonly targetPrice?: string;
  readonly note: string;
}

export interface TicketOutcome {
  readonly kind: 'unknown' | 'blocked' | 'sent';
  readonly title: string;
  readonly detail: string;
}

interface MissionOrderResponse {
  readonly missionId: string;
  readonly intentId: string;
  readonly accepted: boolean;
  readonly deduplicated: boolean;
  readonly problem?: {
    readonly code: string;
    readonly title: string;
    readonly detail: string;
    readonly retryable: boolean;
    readonly outcomeUnknown: boolean;
  };
}

function payload(input: Omit<TicketOrderInput, 'intentId'>): Record<string, unknown> {
  return {
    canonical: input.canonical,
    side: input.side,
    kind: 'market',
    timeInForce: 'GTC',
    stopPrice: input.stopPrice,
    ...(input.targetPrice === undefined || input.targetPrice.length === 0
      ? {}
      : { takeProfitPrice: input.targetPrice }),
    acknowledgeManualSize: false,
    preTradeNote: input.note,
    tags: [],
  };
}

/** Preview is side-effect free and uses the exact order shape submit will use. */
export async function previewTicket(
  client: DeskClient,
  input: Omit<TicketOrderInput, 'intentId'>,
): Promise<ClientResult<TicketPreview>> {
  return client.preview<TicketPreview>(payload(input));
}

/**
 * Submit only through the ADR-0018 Mission-bound route.
 *
 * A 2xx response is not automatically "sent": the Desk can own an intent whose
 * broker outcome is still unknown. The response problem is therefore examined
 * before the UI is allowed to use success language.
 */
export async function submitMissionTicket(
  client: DeskClient,
  missionId: string,
  input: TicketOrderInput,
): Promise<TicketOutcome> {
  if (missionId.trim().length === 0) {
    return {
      kind: 'blocked',
      title: 'No Trade Mission',
      detail: 'This ticket is not attached to a durable Trade Mission, so it cannot be submitted.',
    };
  }

  const res = await client.command<MissionOrderResponse>(
    `/missions/${encodeURIComponent(missionId)}/orders`,
    {
      ...payload(input),
      intentId: input.intentId,
      origin: 'operator:android',
    },
    `${input.side === 'buy' ? 'Long' : 'Short'} ${input.canonical}`,
  );

  if (!res.ok) {
    return {
      kind: res.outcomeUnknown ? 'unknown' : 'blocked',
      title: res.title,
      detail: res.detail,
    };
  }

  if (res.data.problem?.outcomeUnknown === true) {
    return {
      kind: 'unknown',
      title: res.data.problem.title,
      detail: res.data.problem.detail,
    };
  }

  if (!res.data.accepted) {
    return {
      kind: 'blocked',
      title: res.data.problem?.title ?? 'The desk refused this order',
      detail: res.data.problem?.detail ?? 'The durable Mission remains unchanged.',
    };
  }

  return {
    kind: 'sent',
    title: res.data.deduplicated ? 'Already recorded by your desk' : 'Recorded by your desk',
    detail:
      'The desk accepted this Mission-bound intent. Broker state will appear only after it is observed and reconciled.',
  };
}
