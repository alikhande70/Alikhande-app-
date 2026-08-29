import type { DesktopMissionOrder, DesktopOrderOutcome } from './mission-operator.js';
import type { DesktopMissionView, MissionTruthState } from './mission-truth.js';
import {
  DesktopMissionRuntime,
  type DesktopMissionRuntimeStatus,
  type PairedWindowsMissionRuntimeOptions,
} from './runtime.js';

export interface WindowsMissionShellView {
  readonly connection: 'stopped' | 'syncing' | 'ready' | 'blocked';
  readonly missionTruth: MissionTruthState;
  readonly actionable: boolean;
  readonly missions: readonly DesktopMissionView[];
}

function connectionState(
  status: DesktopMissionRuntimeStatus,
): WindowsMissionShellView['connection'] {
  if (!status.started) return 'stopped';
  if (status.actionable) return 'ready';
  if (status.missionTruth === 'empty') return 'syncing';
  return 'blocked';
}

/**
 * Headless Windows application shell around the single Mission runtime.
 *
 * The shell owns no mutable trading truth. Every rendered Mission comes from
 * DesktopMissionRuntime, and every consequential action delegates to its
 * Mission-bound operator. Restart/disconnect therefore cannot re-enable an
 * order from cached UI state: only a fresh server-proven Mission snapshot can.
 */
export class WindowsMissionAppShell {
  private constructor(private readonly runtime: DesktopMissionRuntime) {}

  static async restorePaired(
    options: PairedWindowsMissionRuntimeOptions,
  ): Promise<WindowsMissionAppShell> {
    return new WindowsMissionAppShell(await DesktopMissionRuntime.restorePaired(options));
  }

  start(): void {
    this.runtime.start();
  }

  stop(): void {
    this.runtime.stop();
  }

  view(): WindowsMissionShellView {
    const status = this.runtime.status();
    return {
      connection: connectionState(status),
      missionTruth: status.missionTruth,
      actionable: status.actionable,
      missions: this.runtime.missions(),
    };
  }

  async submitMarketOrder(input: DesktopMissionOrder): Promise<DesktopOrderOutcome> {
    const status = this.runtime.status();
    if (!status.started || !status.actionable) {
      return {
        kind: 'blocked',
        title: 'Mission truth is not current',
        detail:
          'Windows trading actions remain disabled until the authenticated Desk stream proves a current Mission snapshot.',
      };
    }
    return this.runtime.operator.submitMarketOrder(input);
  }
}
