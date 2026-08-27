import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Label, Numeric, Row, useTheme } from '../../src/components/primitives.js';
import { canTrade, useDeskStore } from '../../src/store/desk.js';

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

/**
 * Trade — the chart, and the only place an order can be started.
 *
 * The chart itself is a Skia surface (src/chart/) whose maths lives in
 * geometry.ts and is unit tested off-device. This screen owns the chrome: the
 * instrument, the timeframe, the price header, and the single control that
 * opens the ticket.
 *
 * The buy and sell buttons sit at the bottom, inside thumb reach, and they open
 * the ticket rather than sending anything. There is no one-tap market order in
 * this product, by design.
 *
 * ADR-0018 adds one more hard rule: an internal order starts from a durable
 * Trade Mission. This screen therefore refuses order entry until the Mission
 * topic is complete and a PLANNED/ARMED Mission exists for the instrument.
 */
export default function TradeScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const state = useDeskStore();
  const [canonical, _setCanonical] = useState('XAUUSD');
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>('15m');

  const quote = state.quotes[canonical];
  const gate = canTrade(state);
  const mission = useMemo(
    () =>
      state.missions
        .filter(
          (candidate) =>
            candidate.canonical === canonical &&
            (candidate.stage === 'PLANNED' || candidate.stage === 'ARMED'),
        )
        .sort((a, b) => b.lastEventAt - a.lastEventAt)[0],
    [canonical, state.missions],
  );
  const missionsComplete = state.topics.missions?.status === 'complete';
  const canOpenTicket = gate.ok && missionsComplete && mission !== undefined;
  const missionReason = !missionsComplete
    ? 'Trade Missions are not fully synchronized yet.'
    : mission === undefined
      ? 'No planned Trade Mission exists for this instrument.'
      : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.canvas, paddingTop: insets.top }}>
      <View style={{ paddingHorizontal: theme.space.lg, gap: theme.space.sm }}>
        <Row justify="space-between">
          <Label size="xl" weight="semibold">
            {canonical}
          </Label>
          {quote !== undefined && (
            <Row gap={theme.space.md} align="baseline">
              <Numeric value={quote.bid} size="lg" tone="short" />
              <Numeric value={quote.ask} size="lg" tone="long" />
            </Row>
          )}
        </Row>
        {quote !== undefined && (
          <Row justify="space-between">
            <Label size="xs" tone="tertiary">
              spread {quote.spread}
            </Label>
            {quote.stale && (
              <Label size="xs" tone="critical" weight="semibold">
                STALE — not tradeable
              </Label>
            )}
          </Row>
        )}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.sm,
          gap: theme.space.xs,
        }}
      >
        {TIMEFRAMES.map((tf) => (
          <Pressable
            key={tf}
            onPress={() => setTimeframe(tf)}
            style={{
              minHeight: theme.hit.min,
              minWidth: theme.hit.min,
              paddingHorizontal: theme.space.md,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: theme.radius.md,
              backgroundColor: timeframe === tf ? theme.color.accentMuted : 'transparent',
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: timeframe === tf }}
          >
            <Label weight="semibold" tone={timeframe === tf ? 'accent' : 'tertiary'} size="sm">
              {tf}
            </Label>
          </Pressable>
        ))}
      </ScrollView>

      {/* The Skia chart surface mounts here. Its viewport state lives on the UI
          thread via Reanimated shared values, so pan and zoom never round-trip
          through JS — the single biggest determinant of whether a mobile chart
          feels like a tool or a toy. */}
      <View
        style={{
          flex: 1,
          marginHorizontal: theme.space.md,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.color.surface,
          borderWidth: 1,
          borderColor: theme.color.border,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        accessibilityLabel={`${canonical} ${timeframe} chart`}
      >
        <Label tone="tertiary" size="sm">
          Chart surface — see src/chart/geometry.ts for the tested maths
        </Label>
      </View>

      <View
        style={{
          padding: theme.space.lg,
          paddingBottom: insets.bottom + theme.space.md,
          gap: theme.space.sm,
        }}
      >
        {!gate.ok && gate.reason !== undefined && (
          <Label size="xs" tone="warning" style={{ textAlign: 'center' }}>
            {gate.reason}
          </Label>
        )}
        {gate.ok && missionReason !== undefined && (
          <Label size="xs" tone="warning" style={{ textAlign: 'center' }}>
            {missionReason}
          </Label>
        )}
        {mission !== undefined && missionsComplete && (
          <Label size="xs" tone="tertiary" style={{ textAlign: 'center' }}>
            Mission {mission.missionId.slice(0, 8)} · {mission.stage.toLowerCase()}
          </Label>
        )}
        <Row gap={theme.space.sm}>
          {(['sell', 'buy'] as const).map((side) => (
            <Pressable
              key={side}
              disabled={!canOpenTicket}
              onPress={() => {
                if (mission === undefined) return;
                router.push(
                  `/ticket?canonical=${encodeURIComponent(canonical)}&side=${side}&missionId=${encodeURIComponent(mission.missionId)}`,
                );
              }}
              style={{
                flex: 1,
                minHeight: theme.hit.commit,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: theme.radius.lg,
                backgroundColor: side === 'buy' ? theme.color.longMuted : theme.color.shortMuted,
                borderWidth: 1,
                borderColor: side === 'buy' ? theme.color.long : theme.color.short,
                opacity: canOpenTicket ? 1 : 0.4,
              }}
              accessibilityRole="button"
              accessibilityLabel={`Open the ticket to ${side === 'buy' ? 'go long' : 'go short'} ${canonical}`}
            >
              <Label size="lg" weight="bold">
                {side === 'buy' ? 'Long' : 'Short'}
              </Label>
              <Label size="xs" tone="tertiary">
                opens the Mission ticket
              </Label>
            </Pressable>
          ))}
        </Row>
      </View>
    </View>
  );
}
