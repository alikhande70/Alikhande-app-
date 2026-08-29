import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Card,
  CertaintyChip,
  Label,
  Numeric,
  Row,
  useTheme,
} from '../../src/components/primitives.js';
import { useDeskStore } from '../../src/store/desk.js';

/**
 * Book — what the broker actually holds.
 *
 * The ordering is by consequence again: unprotected positions first, then
 * orders whose state is not confirmed, then everything settled. A position with
 * no stop is never below the fold.
 *
 * Nothing on this screen is inferred. Every row came from the desk, which got
 * it from the broker; where the desk is unsure, the row says so rather than
 * looking like the ones that are certain.
 */
export default function BookScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { positions, orders, topics, connection } = useDeskStore();

  const naked = positions.filter((p) => p.stopPrice === undefined || p.stopPrice === null);
  const protectedPositions = positions.filter(
    (p) => p.stopPrice !== undefined && p.stopPrice !== null,
  );
  const liveOrders = orders.filter((o) => o.certainty !== 'confirmed' || o.state === 'WORKING');
  const incomplete = topics.positions?.status === 'incomplete' || connection !== 'connected';

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
      <Row justify="space-between">
        <Label size="xl" weight="semibold">
          Book
        </Label>
        <Pressable
          onPress={() => router.push('/panic')}
          style={{
            minHeight: theme.hit.min,
            paddingHorizontal: theme.space.lg,
            justifyContent: 'center',
            borderRadius: theme.radius.pill,
            borderWidth: 1,
            borderColor: theme.color.critical,
          }}
          accessibilityRole="button"
          accessibilityLabel="Close everything and stop trading"
        >
          <Label tone="critical" weight="semibold" size="sm">
            Flatten
          </Label>
        </Pressable>
      </Row>

      {incomplete && (
        <Card tone="warning">
          <Label size="sm" weight="semibold">
            This may not be complete
          </Label>
          <Label size="sm" tone="secondary">
            The desk connection is not confirmed, so this is the last state we could verify — not
            necessarily the current one.
          </Label>
        </Card>
      )}

      {naked.length > 0 && (
        <Card tone="critical">
          <Label weight="semibold" tone="critical">
            Unprotected
          </Label>
          {naked.map((p) => (
            <PositionRow key={p.positionId} position={p} unprotected />
          ))}
        </Card>
      )}

      {liveOrders.length > 0 && (
        <Card>
          <Label size="sm" tone="secondary">
            Orders
          </Label>
          {liveOrders.map((o) => (
            <View
              key={o.intentId}
              style={{ gap: theme.space.xxs, paddingVertical: theme.space.xs }}
            >
              <Row justify="space-between">
                <Row gap={theme.space.sm}>
                  <Label weight="semibold">{o.canonical}</Label>
                  <Label size="xs" tone="tertiary">
                    {o.state.replace(/_/g, ' ').toLowerCase()}
                  </Label>
                </Row>
                <CertaintyChip certainty={o.certainty} text={o.certaintyText} />
              </Row>
              <Row justify="space-between">
                <Numeric value={`${o.filledQty} / ${o.requestedQty}`} size="sm" tone="secondary" />
                {o.venueOrderId !== undefined && (
                  <Label size="xs" tone="tertiary">
                    broker id {o.venueOrderId}
                  </Label>
                )}
              </Row>
              {o.certainty !== 'confirmed' && (
                <Label size="xs" tone="secondary">
                  {o.certaintyText}
                </Label>
              )}
            </View>
          ))}
        </Card>
      )}

      <Card>
        <Label size="sm" tone="secondary">
          Positions
        </Label>
        {protectedPositions.length === 0 && naked.length === 0 ? (
          <Label tone="tertiary">Flat. The broker reports no open positions.</Label>
        ) : (
          protectedPositions.map((p) => <PositionRow key={p.positionId} position={p} />)
        )}
      </Card>
    </ScrollView>
  );
}

function PositionRow({
  position,
  unprotected = false,
}: {
  position: ReturnType<typeof useDeskStore.getState>['positions'][number];
  unprotected?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() =>
        router.push(
          `/ticket?positionId=${position.positionId}&canonical=${position.canonical}&mode=${
            unprotected ? 'protect' : 'manage'
          }`,
        )
      }
      style={{ minHeight: theme.hit.comfortable, justifyContent: 'center', gap: theme.space.xxs }}
      accessibilityRole="button"
      accessibilityLabel={`${position.side} ${position.volume} ${position.canonical}${
        unprotected ? ', no stop attached' : ''
      }`}
    >
      <Row justify="space-between">
        <Row gap={theme.space.sm}>
          <View
            style={{
              width: 3,
              height: 22,
              borderRadius: 2,
              backgroundColor: position.side === 'buy' ? theme.color.long : theme.color.short,
            }}
          />
          <Label weight="semibold">{position.canonical}</Label>
          {position.foreign && (
            <Label size="xs" tone="warning">
              opened elsewhere
            </Label>
          )}
        </Row>
        <Numeric value={position.volume} tone={position.side === 'buy' ? 'long' : 'short'} />
      </Row>
      <Row justify="space-between">
        <Label size="xs" tone="tertiary">
          entry {position.entryPrice}
        </Label>
        {unprotected ? (
          <Label size="xs" tone="critical" weight="semibold">
            NO STOP — tap to attach
          </Label>
        ) : (
          <Label size="xs" tone="tertiary">
            stop {position.stopPrice}
          </Label>
        )}
      </Row>
    </Pressable>
  );
}
