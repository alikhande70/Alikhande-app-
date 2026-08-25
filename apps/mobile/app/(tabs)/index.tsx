import { useMemo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  AgeBadge,
  Card,
  CertaintyChip,
  Label,
  Numeric,
  Pnl,
  Row,
  useTheme,
} from '../../src/components/primitives.js';
import {
  canTrade,
  dataAgeMs,
  needsAttention,
  unprotectedPositions,
  useDeskStore,
} from '../../src/store/desk.js';

/**
 * Pulse — the home screen.
 *
 * Its job is to answer one question in under a second: **is anything wrong?**
 *
 * So it is ordered by consequence, not by category. Anything that could cost
 * money is at the top, in the operator's thumb reach, and the pleasant
 * information — equity, today's P&L — is below it. On a good day the top of
 * this screen is empty, and that emptiness is the message.
 *
 * What it deliberately does not contain: a watchlist, movers, news, or anything
 * else whose purpose is to suggest a trade. Nothing on this screen exists to
 * make the operator want to do something.
 */
export default function PulseScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const state = useDeskStore();
  const now = Date.now();

  const trade = canTrade(state);
  const attention = needsAttention(state);
  const naked = unprotectedPositions(state);
  const criticalAlerts = state.alerts.filter(
    (a) => a.severity === 'critical' && a.acknowledgedAt === undefined,
  );
  const criticalDivergences = state.divergences.filter((d) => d.severity === 'critical');

  const accountAge = dataAgeMs(state, 'account', now);
  const freshness = useMemo(() => {
    if (accountAge === undefined) return 'stale' as const;
    if (accountAge < 3_000) return 'live' as const;
    if (accountAge < 30_000) return 'aging' as const;
    return 'stale' as const;
  }, [accountAge]);

  const allClear =
    trade.ok &&
    attention.length === 0 &&
    naked.length === 0 &&
    criticalAlerts.length === 0 &&
    criticalDivergences.length === 0;

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
      <ConnectionBar />

      {/* --- Consequence first ------------------------------------------- */}

      {naked.length > 0 && (
        <Card tone="critical">
          <Label size="lg" weight="semibold" tone="critical">
            {naked.length === 1 ? 'A position has no stop' : `${naked.length} positions have no stop`}
          </Label>
          <Label size="sm" tone="secondary">
            Their downside is unbounded until one is attached.
          </Label>
          {naked.map((p) => (
            <Pressable
              key={p.positionId}
              onPress={() => router.push(`/ticket?positionId=${p.positionId}&mode=protect`)}
              style={{ minHeight: theme.hit.comfortable, justifyContent: 'center' }}
              accessibilityRole="button"
              accessibilityLabel={`Attach a stop to ${p.canonical}`}
            >
              <Row justify="space-between">
                <Label weight="semibold">{p.canonical}</Label>
                <Row gap={theme.space.sm}>
                  <Numeric value={p.volume} tone={p.side === 'buy' ? 'long' : 'short'} />
                  <Label tone="accent" weight="semibold">
                    Attach stop
                  </Label>
                </Row>
              </Row>
            </Pressable>
          ))}
        </Card>
      )}

      {attention.length > 0 && (
        <Card tone={attention.some((o) => o.certainty === 'unknown') ? 'unknown' : 'warning'}>
          <Label size="lg" weight="semibold">
            {attention.length === 1 ? 'One order needs attention' : `${attention.length} orders need attention`}
          </Label>
          {attention.slice(0, 4).map((o) => (
            <Pressable
              key={o.intentId}
              onPress={() => router.push(`/order/${o.intentId}`)}
              style={{ minHeight: theme.hit.comfortable, justifyContent: 'center', gap: theme.space.xs }}
              accessibilityRole="button"
              accessibilityLabel={`${o.canonical} ${o.state}. ${o.certaintyText}`}
            >
              <Row justify="space-between">
                <Row gap={theme.space.sm}>
                  <Label weight="semibold">{o.canonical}</Label>
                  <CertaintyChip certainty={o.certainty} text={o.certaintyText} />
                </Row>
                <Numeric value={`${o.filledQty}/${o.requestedQty}`} size="sm" tone="secondary" />
              </Row>
              {/* Rendered verbatim from the desk, so the wording cannot drift
                  from the state machine that produced it. */}
              <Label size="sm" tone="secondary">
                {o.certaintyText}
              </Label>
            </Pressable>
          ))}
        </Card>
      )}

      {criticalDivergences.length > 0 && (
        <Card tone="critical">
          <Label size="lg" weight="semibold" tone="critical">
            The broker disagrees with us
          </Label>
          {criticalDivergences.slice(0, 3).map((d) => (
            <View key={`${d.kind}-${d.canonical ?? ''}`} style={{ gap: theme.space.xxs }}>
              <Label weight="semibold" size="sm">
                {d.kind.replace(/_/g, ' ').toLowerCase()}
              </Label>
              <Label size="sm" tone="secondary">
                {d.detail}
              </Label>
              <Row gap={theme.space.lg}>
                <Label size="xs" tone="tertiary">
                  we say {d.local}
                </Label>
                <Label size="xs" tone="tertiary">
                  broker says {d.venue}
                </Label>
              </Row>
            </View>
          ))}
        </Card>
      )}

      {!trade.ok && trade.reason !== undefined && (
        <Card tone="warning">
          <Label weight="semibold">Order entry is off</Label>
          <Label size="sm" tone="secondary">
            {trade.reason}
          </Label>
        </Card>
      )}

      {allClear && (
        <Card>
          <Label size="lg" weight="semibold" tone="secondary">
            Nothing needs you
          </Label>
          <Label size="sm" tone="tertiary">
            Positions protected, orders confirmed, broker agrees.
          </Label>
        </Card>
      )}

      {/* --- Then the numbers --------------------------------------------- */}

      <Card>
        <Row justify="space-between">
          <Label size="sm" tone="secondary">
            Equity
          </Label>
          <AgeBadge ageMs={accountAge} freshness={freshness} />
        </Row>
        {state.account === undefined ? (
          <Label tone="tertiary">No account data from the desk yet.</Label>
        ) : (
          <>
            <Numeric value={state.account.equity} size="display" weight="semibold" />
            <Row justify="space-between">
              <Label size="sm" tone="tertiary">
                balance {state.account.balance} {state.account.currency}
              </Label>
              <Label size="sm" tone="tertiary">
                free margin {state.account.marginFree}
              </Label>
            </Row>
          </>
        )}
      </Card>

      {state.drawdown !== undefined && state.drawdown.status !== 'not-applicable' && (
        <Card tone={state.drawdown.status === 'breached' ? 'critical' : state.drawdown.status === 'warning' ? 'warning' : 'default'}>
          <Row justify="space-between">
            <Label size="sm" tone="secondary">
              Drawdown buffer
            </Label>
            <Label size="xs" tone="tertiary">
              floor {state.drawdown.floor}
            </Label>
          </Row>
          <Row align="baseline" gap={theme.space.sm}>
            <Numeric
              value={state.drawdown.buffer}
              size="xl"
              weight="semibold"
              tone={state.drawdown.status === 'ok' ? 'default' : 'warning'}
            />
            <Label size="sm" tone="tertiary">
              left before the account ends
            </Label>
          </Row>
          <BufferBar fraction={Number(state.drawdown.bufferFraction)} status={state.drawdown.status} />
          <Label size="xs" tone="tertiary">
            {state.drawdown.explain}
          </Label>
        </Card>
      )}

      <Card>
        <Label size="sm" tone="secondary">
          Open positions
        </Label>
        {state.positions.length === 0 ? (
          <Label tone="tertiary">Flat.</Label>
        ) : (
          state.positions.map((p) => (
            <Row key={p.positionId} justify="space-between" style={{ minHeight: theme.hit.min }}>
              <Row gap={theme.space.sm}>
                <View
                  style={{
                    width: 3,
                    height: 20,
                    borderRadius: 2,
                    backgroundColor: p.side === 'buy' ? theme.color.long : theme.color.short,
                  }}
                />
                <Label weight="semibold">{p.canonical}</Label>
                {p.foreign && (
                  <Label size="xs" tone="warning">
                    opened elsewhere
                  </Label>
                )}
              </Row>
              <Row gap={theme.space.md}>
                <Numeric value={p.volume} size="sm" tone="secondary" />
                {p.stopPrice === undefined || p.stopPrice === null ? (
                  <Label size="xs" tone="critical" weight="semibold">
                    NO STOP
                  </Label>
                ) : (
                  <Numeric value={p.stopPrice} size="sm" tone="tertiary" />
                )}
              </Row>
            </Row>
          ))
        )}
      </Card>
    </ScrollView>
  );
}

/**
 * The connection bar sits above everything, always.
 *
 * The operator should never have to wonder whether what they are looking at is
 * live. When it is not, this says so in words rather than by the absence of
 * movement — a still screen and a dead socket look identical.
 */
function ConnectionBar() {
  const theme = useTheme();
  const { connection, connectionDetail, health, rttMs } = useDeskStore();

  const { text, tone } =
    connection === 'connected' && health?.brokerConnected === true
      ? { text: `${health.brokerName} · live`, tone: 'tertiary' as const }
      : connection === 'connected'
        ? { text: `desk up · ${health?.brokerName ?? 'broker'} disconnected`, tone: 'critical' as const }
        : connection === 'resyncing'
          ? { text: `resyncing${connectionDetail !== undefined ? ` · ${connectionDetail}` : ''}`, tone: 'warning' as const }
          : connection === 'connecting'
            ? { text: 'connecting to your desk', tone: 'warning' as const }
            : { text: 'not connected — showing last known state', tone: 'critical' as const };

  return (
    <Row justify="space-between" style={{ paddingHorizontal: theme.space.xs }}>
      <Row gap={theme.space.xs}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor:
              tone === 'tertiary'
                ? theme.color.ok
                : tone === 'warning'
                  ? theme.color.warning
                  : theme.color.critical,
          }}
        />
        <Label size="xs" tone={tone}>
          {text}
        </Label>
      </Row>
      {rttMs !== undefined && (
        <Label size="xs" tone="tertiary">
          {Math.round(rttMs)}ms
        </Label>
      )}
    </Row>
  );
}

function BufferBar({ fraction, status }: { fraction: number; status: string }) {
  const theme = useTheme();
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const color =
    status === 'breached'
      ? theme.color.critical
      : status === 'warning'
        ? theme.color.warning
        : theme.color.ok;
  return (
    <View
      style={{
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.color.surfaceSunken,
        overflow: 'hidden',
      }}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}
    >
      <View style={{ width: `${pct * 100}%`, height: '100%', backgroundColor: color }} />
    </View>
  );
}
