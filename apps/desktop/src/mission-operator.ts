import type { DesktopDeskClient, DesktopResult } from './client.js';

export interface DesktopMissionOrder {
  readonly missionId: string;
  readonly intentId: string;
  readonly canonical: string;
  readonly side: 'buy' | 'sell';
  readonly stopPrice: string;
  readonly takeProfitPrice?: string;
  readonly note: string;
}

export interface DesktopOrderOutcome {
  readonly kind: 'sent' | 'blocked' | 'unknown';
  readonly title: string;
  readonly detail: string;
}

interface MissionOrderResponse {
  readonly missionId: string;
  readonly intentId: string;
  readonly accepted: boolean;
  readonly deduplicated: boolean;
  readonly problem?: {
    readonly title: string;
    readonly detail: string;
    readonly outcomeUnknown: boolean;
  };
}

export class DesktopMissionOperator {
  constructor(private readonly client: DesktopDeskClient) {}

  async listMissions<T>(limit = 100): Promise<DesktopResult<T>> {
    const bounded = Math.max(1, Math.min(250, Math.trunc(limit)));
    return this.client.get<T>(`/missions?limit=${bounded}`);
  }

  async submitMarketOrder(input: DesktopMissionOrder): Promise<DesktopOrderOutcome> {
    if (input.missionId.trim().length === 0) {
      return {
        kind: 'blocked',
        title: 'Trade Mission required',
        detail: 'A Windows order cannot be created without a durable Mission id.',
      };
    }

    const result = await this.client.command<MissionOrderResponse>(
      `/missions/${encodeURIComponent(input.missionId)}/orders`,
      {
        intentId: input.intentId,
        canonical: input.canonical,
        side: input.side,
        kind: 'market',
        timeInForce: 'GTC',
        stopPrice: input.stopPrice,
        ...(input.takeProfitPrice === undefined ? {} : { takeProfitPrice: input.takeProfitPrice }),
        acknowledgeManualSize: false,
        preTradeNote: input.note,
        tags: [],
        origin: 'operator:windows',
      },
      `${input.side === 'buy' ? 'Long' : 'Short'} ${input.canonical}`,
    );

    if (!result.ok) {
      return {
        kind: result.outcomeUnknown ? 'unknown' : 'blocked',
        title: result.title,
        detail: result.detail,
      };
    }

    if (result.data.problem?.outcomeUnknown === true) {
      return {
        kind: 'unknown',
        title: result.data.problem.title,
        detail: result.data.problem.detail,
      };
    }

    if (!result.data.accepted) {
      return {
        kind: 'blocked',
        title: result.data.problem?.title ?? 'The desk refused this order',
        detail:
          result.data.problem?.detail ?? 'The Mission remains durable and no success is assumed.',
      };
    }

    return {
      kind: 'sent',
      title: result.data.deduplicated ? 'Already recorded by the desk' : 'Recorded by the desk',
      detail:
        'The Mission-bound intent is owned by the desk. Broker state is not claimed until observed and reconciled.',
    };
  }
}
