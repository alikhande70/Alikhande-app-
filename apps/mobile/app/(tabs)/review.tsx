import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, Label, Numeric, Row, useTheme } from '../../src/components/primitives.js';

/**
 * Review — the journal and what it says about the operator.
 *
 * Every figure here arrives with the sample size that produced it, and the
 * desk's own verdict on whether that sample supports a conclusion. A 12-trade
 * "edge" is displayed as description, not evidence, in the same words the
 * analytics module uses — because the most expensive mistake in personal
 * trading is treating thirty trades as proof.
 */
export default function ReviewScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  // Populated from GET /journal and the analytics endpoint by the app shell.
  interface Summary {
    trades: number;
    expectancyR: string;
    winRate: string;
    profitFactor?: string;
    maxDrawdownR: string;
    confidence: { verdict: string; note: string };
  }
  const summary = undefined as Summary | undefined;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.color.canvas }}
      contentContainerStyle={{
        padding: theme.space.lg,
        paddingTop: insets.top + theme.space.md,
        paddingBottom: insets.bottom + theme.space.xxl,
        gap: theme.space.md,
      }}
    >
      <Label size="xl" weight="semibold">Review</Label>

      {summary === undefined ? (
        <Card>
          <Label tone="tertiary">No closed trades yet.</Label>
          <Label size="sm" tone="tertiary">
            Every trade you take is captured with its context automatically — spread at entry,
            session, distance to the next scheduled event, slippage and latency. Nothing here has
            to be typed in twice.
          </Label>
        </Card>
      ) : (
        <>
          <Card tone={summary.confidence.verdict === 'insufficient' ? 'warning' : 'default'}>
            <Label size="sm" tone="secondary">Expectancy</Label>
            <Row align="baseline" gap={theme.space.sm}>
              <Numeric value={`${summary.expectancyR}R`} size="display" weight="semibold" />
              <Label size="sm" tone="tertiary">per trade</Label>
            </Row>
            <Label size="sm" tone={summary.confidence.verdict === 'meaningful' ? 'secondary' : 'warning'}>
              {summary.confidence.note}
            </Label>
          </Card>

          <Card>
            <Row justify="space-between">
              <Label size="sm" tone="secondary">Trades</Label>
              <Numeric value={String(summary.trades)} />
            </Row>
            <Row justify="space-between">
              <Label size="sm" tone="secondary">Win rate</Label>
              <Numeric value={summary.winRate} />
            </Row>
            <Row justify="space-between">
              <Label size="sm" tone="secondary">Profit factor</Label>
              <Numeric value={summary.profitFactor ?? '—'} />
            </Row>
            <Row justify="space-between">
              <Label size="sm" tone="secondary">Worst run</Label>
              <Numeric value={`${summary.maxDrawdownR}R`} tone="warning" />
            </Row>
          </Card>
        </>
      )}

      <Card>
        <Label size="sm" tone="secondary">Ask the copilot</Label>
        <Label size="sm" tone="tertiary">
          It can only read your own ledger and journal. It cannot place, modify or cancel anything,
          and every figure it quotes carries the record it came from. If it cannot cite something,
          it will not say it.
        </Label>
      </Card>
    </ScrollView>
  );
}
