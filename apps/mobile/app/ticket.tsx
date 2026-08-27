import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { currentDeskClient } from '../src/api/runtime.js';
import { Card, Label, Numeric, Row, useTheme } from '../src/components/primitives.js';
import { SlideToCommit } from '../src/components/SlideToCommit.js';
import { canTrade, useDeskStore } from '../src/store/desk.js';
import {
  previewTicket,
  submitMissionTicket,
  type TicketOutcome,
  type TicketPreview,
} from '../src/trading/ticket-transport.js';

/**
 * The order ticket.
 *
 * The design rule is: **the operator states a stop, never a size.** Size is
 * derived by the desk from the stop, the risk policy and the venue's contract
 * specification. Choosing a lot size and then discovering what it risks is how
 * accounts die, and this screen does not offer that direction.
 *
 * The flow is deliberately three steps, and the friction is deliberate too:
 *
 *   1. Direction and stop — two taps, thumb-reachable.
 *   2. Why — a written note, required before anything can be sent. This is the
 *      single highest-leverage discipline lever available, and it costs eight
 *      seconds.
 *   3. Commit — a slide, not a tap, with the money at risk restated in words
 *      immediately above the gesture.
 *
 * Everything the desk refused is shown in full, with the rule that refused it,
 * because "blocked" without a reason teaches the operator to distrust the tool.
 *
 * ADR-0018 adds two non-negotiable truth rules: this ticket must carry a durable
 * Mission id, and it may show "sent" only after the authenticated Desk command
 * returns an accepted Mission-bound intent. Local UI state is never execution
 * evidence.
 */
export default function TicketScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    canonical?: string;
    side?: string;
    positionId?: string;
    missionId?: string;
  }>();
  const state = useDeskStore();

  const canonical = params.canonical ?? 'XAUUSD';
  const missionId = params.missionId;
  const deskClient = currentDeskClient();
  const [side, setSide] = useState<'buy' | 'sell'>(params.side === 'sell' ? 'sell' : 'buy');
  const [stopPrice, setStopPrice] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<TicketPreview | undefined>(undefined);
  const [previewProblem, setPreviewProblem] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<TicketOutcome | undefined>(undefined);

  /**
   * The intent id is minted once, when the ticket opens, and reused for every
   * retry of *this* decision. Generating it at send time would make a retry a
   * different order (ADR-0006).
   */
  const intentId = useRef(makeUuidV7());

  const quote = state.quotes[canonical];
  const gate = canTrade(state);
  const blockers = preview?.risk.checks.filter((c) => c.verdict === 'block') ?? [];
  const warnings = preview?.risk.checks.filter((c) => c.verdict === 'warn') ?? [];
  const sizing = preview?.sizing;
  // Explicitly `=== true`: `sizing?.ok` is `boolean | undefined`, and an
  // undefined sizing result means "we do not know how big this should be",
  // which must gate the commit shut rather than leak an undefined through it.
  const sized = sizing?.ok === true;
  const missionReady = missionId !== undefined && missionId.trim().length > 0;
  const transportReady = deskClient !== undefined;

  const readyToCommit =
    gate.ok &&
    missionReady &&
    transportReady &&
    sized &&
    blockers.length === 0 &&
    note.trim().length >= 10 &&
    stopPrice.trim().length > 0 &&
    !submitting;

  const commitLabel = useMemo(() => {
    if (!missionReady) return 'Trade Mission required';
    if (!transportReady) return 'Desk transport unavailable';
    if (!sized) return 'Set a stop to size this';
    const s = sizing as Extract<NonNullable<TicketPreview['sizing']>, { ok: true }>;
    return `Slide to risk ${s.riskAtStop} ${state.account?.currency ?? ''}`;
  }, [missionReady, transportReady, sized, sizing, state.account?.currency]);

  // The preview is the Desk's real risk/sizing path, not client arithmetic.
  // Debounce edits and discard late responses so an old stop cannot overwrite a
  // newer proposal on screen.
  useEffect(() => {
    setPreview(undefined);
    setPreviewProblem(undefined);
    if (!gate.ok || deskClient === undefined || stopPrice.trim().length === 0) return;

    let current = true;
    const timer = setTimeout(() => {
      void previewTicket(deskClient, {
        canonical,
        side,
        stopPrice: stopPrice.trim(),
        ...(targetPrice.trim().length === 0 ? {} : { targetPrice: targetPrice.trim() }),
        note: note.trim(),
      }).then((result) => {
        if (!current) return;
        if (result.ok) {
          setPreview(result.data);
          return;
        }
        setPreviewProblem(result.detail);
      });
    }, 250);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [canonical, deskClient, gate.ok, note, side, stopPrice, targetPrice]);

  const onCommit = useCallback(async () => {
    setSubmitting(true);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);

    if (deskClient === undefined) {
      setOutcome({
        kind: 'blocked',
        title: 'Desk transport unavailable',
        detail:
          'This phone does not currently hold an authenticated Desk client. Nothing was sent.',
      });
      setSubmitting(false);
      return;
    }
    if (missionId === undefined || missionId.trim().length === 0) {
      setOutcome({
        kind: 'blocked',
        title: 'No Trade Mission',
        detail: 'This ticket is not attached to a durable Trade Mission. Nothing was sent.',
      });
      setSubmitting(false);
      return;
    }

    const result = await submitMissionTicket(deskClient, missionId, {
      intentId: intentId.current,
      canonical,
      side,
      stopPrice: stopPrice.trim(),
      ...(targetPrice.trim().length === 0 ? {} : { targetPrice: targetPrice.trim() }),
      note: note.trim(),
    });
    setOutcome(result);
    setSubmitting(false);
  }, [canonical, deskClient, missionId, note, side, stopPrice, targetPrice]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.color.canvas }}
      contentContainerStyle={{
        padding: theme.space.lg,
        paddingBottom: insets.bottom + theme.space.xxxl,
        gap: theme.space.md,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <Row justify="space-between">
        <Label size="xl" weight="semibold">
          {canonical}
        </Label>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={{ minHeight: theme.hit.min, justifyContent: 'center' }}
          accessibilityRole="button"
          accessibilityLabel="Cancel this order"
        >
          <Label tone="secondary">Cancel</Label>
        </Pressable>
      </Row>

      {outcome !== undefined ? (
        <Outcome outcome={outcome} />
      ) : (
        <>
          {!gate.ok && (
            <Card tone="critical">
              <Label weight="semibold">Cannot send right now</Label>
              <Label size="sm" tone="secondary">
                {gate.reason}
              </Label>
            </Card>
          )}

          {!missionReady && (
            <Card tone="critical">
              <Label weight="semibold">Trade Mission required</Label>
              <Label size="sm" tone="secondary">
                Internal orders must come from a durable planned Mission. Open this ticket from a
                Mission-aware trade flow.
              </Label>
            </Card>
          )}

          {!transportReady && (
            <Card tone="critical">
              <Label weight="semibold">Desk transport unavailable</Label>
              <Label size="sm" tone="secondary">
                This phone has no authenticated Desk client installed in the app runtime. The ticket
                fails closed and cannot claim a handoff.
              </Label>
            </Card>
          )}

          {/* --- 1. Direction ------------------------------------------- */}
          <Row gap={theme.space.sm}>
            {(['buy', 'sell'] as const).map((s) => (
              <Pressable
                key={s}
                onPress={() => {
                  setSide(s);
                  void Haptics.selectionAsync();
                }}
                style={{
                  flex: 1,
                  minHeight: theme.hit.commit,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: theme.radius.lg,
                  borderWidth: 2,
                  borderColor:
                    side === s
                      ? s === 'buy'
                        ? theme.color.long
                        : theme.color.short
                      : theme.color.border,
                  backgroundColor:
                    side === s
                      ? s === 'buy'
                        ? theme.color.longMuted
                        : theme.color.shortMuted
                      : 'transparent',
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: side === s }}
                accessibilityLabel={s === 'buy' ? 'Buy, long' : 'Sell, short'}
              >
                <Label size="lg" weight="bold" tone={side === s ? 'default' : 'tertiary'}>
                  {s === 'buy' ? 'Long' : 'Short'}
                </Label>
                {quote !== undefined && (
                  <Numeric value={s === 'buy' ? quote.ask : quote.bid} size="sm" tone="secondary" />
                )}
              </Pressable>
            ))}
          </Row>

          {quote?.stale === true && (
            <Card tone="warning">
              <Label size="sm" weight="semibold">
                This price is stale
              </Label>
              <Label size="sm" tone="secondary">
                The desk will refuse an order built from it. Wait for a fresh quote.
              </Label>
            </Card>
          )}

          {/* --- 2. The stop, which sizes the trade ---------------------- */}
          <Card>
            <Label size="sm" tone="secondary">
              Stop — this is what sizes the trade
            </Label>
            <TextInput
              value={stopPrice}
              onChangeText={setStopPrice}
              placeholder={
                quote === undefined ? '—' : side === 'buy' ? 'below entry' : 'above entry'
              }
              placeholderTextColor={theme.color.textTertiary}
              keyboardType="decimal-pad"
              inputMode="decimal"
              style={{
                ...theme.type.numeric.xl,
                fontVariant: ['tabular-nums'],
                color: theme.color.text,
                minHeight: theme.hit.commit,
                paddingHorizontal: theme.space.sm,
                borderRadius: theme.radius.md,
                backgroundColor: theme.color.surfaceSunken,
              }}
              accessibilityLabel="Stop price"
            />
            <Label size="xs" tone="tertiary">
              Size is derived by the desk from your risk policy and the broker's contract
              specification. You never enter a lot size here.
            </Label>
          </Card>

          <Card>
            <Label size="sm" tone="secondary">
              Target (optional)
            </Label>
            <TextInput
              value={targetPrice}
              onChangeText={setTargetPrice}
              placeholder="—"
              placeholderTextColor={theme.color.textTertiary}
              keyboardType="decimal-pad"
              inputMode="decimal"
              style={{
                ...theme.type.numeric.lg,
                fontVariant: ['tabular-nums'],
                color: theme.color.text,
                minHeight: theme.hit.comfortable,
                paddingHorizontal: theme.space.sm,
                borderRadius: theme.radius.md,
                backgroundColor: theme.color.surfaceSunken,
              }}
              accessibilityLabel="Take profit price"
            />
          </Card>

          {/* --- What the desk computed --------------------------------- */}
          {previewProblem !== undefined && (
            <Card tone="warning">
              <Label weight="semibold">Desk preview unavailable</Label>
              <Label size="sm" tone="secondary">
                {previewProblem}
              </Label>
            </Card>
          )}

          {sizing !== undefined && !sizing.ok && (
            <Card tone="warning">
              <Label weight="semibold">Cannot size this</Label>
              <Label size="sm" tone="secondary">
                {sizing.detail}
              </Label>
              {sizing.riskAtVenueBound !== undefined && (
                <Label size="sm" tone="tertiary">
                  The smallest size this broker accepts would risk {sizing.riskAtVenueBound}.
                </Label>
              )}
            </Card>
          )}

          {sized && (
            <Card>
              <Row justify="space-between">
                <Label size="sm" tone="secondary">
                  Size
                </Label>
                <Numeric
                  value={(sizing as { volume: string }).volume}
                  size="lg"
                  weight="semibold"
                />
              </Row>
              <Row justify="space-between">
                <Label size="sm" tone="secondary">
                  At risk
                </Label>
                <Numeric
                  value={(sizing as { riskAtStop: string }).riskAtStop}
                  size="lg"
                  weight="semibold"
                  tone="warning"
                />
              </Row>
              {(sizing as { rewardToRisk?: string }).rewardToRisk !== undefined && (
                <Row justify="space-between">
                  <Label size="sm" tone="secondary">
                    Reward : risk
                  </Label>
                  <Numeric value={`${(sizing as { rewardToRisk?: string }).rewardToRisk}R`} />
                </Row>
              )}
              {(sizing as { crossCheckDivergencePct?: string }).crossCheckDivergencePct !==
                undefined && (
                <Label size="xs" tone="warning">
                  The broker's tick value disagrees with contract-size maths by{' '}
                  {(sizing as { crossCheckDivergencePct?: string }).crossCheckDivergencePct}. One of
                  them is wrong — check before sending.
                </Label>
              )}
            </Card>
          )}

          {/* --- 3. Why ------------------------------------------------- */}
          <Card>
            <Label size="sm" tone="secondary">
              Why are you taking this trade?
            </Label>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Required before this can be sent"
              placeholderTextColor={theme.color.textTertiary}
              multiline
              style={{
                ...theme.type.ui.md,
                color: theme.color.text,
                minHeight: 88,
                padding: theme.space.md,
                borderRadius: theme.radius.md,
                backgroundColor: theme.color.surfaceSunken,
                textAlignVertical: 'top',
              }}
              accessibilityLabel="Pre-trade note, required"
            />
            {note.trim().length > 0 && note.trim().length < 10 && (
              <Label size="xs" tone="warning">
                A few more words. This is the note you will read when reviewing the trade.
              </Label>
            )}
          </Card>

          {blockers.length > 0 && (
            <Card tone="critical">
              <Label weight="semibold">Blocked by your own rules</Label>
              {blockers.map((c) => (
                <View key={c.rule} style={{ gap: 2 }}>
                  <Label size="sm" weight="semibold">
                    {c.rule}
                  </Label>
                  <Label size="sm" tone="secondary">
                    {c.message}
                  </Label>
                  <Label size="xs" tone="tertiary">
                    {c.observed} vs limit {c.limit}
                  </Label>
                </View>
              ))}
            </Card>
          )}

          {warnings.length > 0 && (
            <Card tone="warning">
              <Label weight="semibold">Worth knowing</Label>
              {warnings.map((c) => (
                <Label key={c.rule} size="sm" tone="secondary">
                  {c.message}
                </Label>
              ))}
            </Card>
          )}

          <SlideToCommit
            label={commitLabel}
            enabled={readyToCommit}
            side={side}
            onCommit={onCommit}
          />

          <Label size="xs" tone="tertiary" style={{ textAlign: 'center' }}>
            Intent {intentId.current.slice(0, 8)} · Mission {missionId?.slice(0, 8) ?? 'missing'} · a
            retry of this decision reuses the same intent id.
          </Label>
        </>
      )}
    </ScrollView>
  );
}

function Outcome({ outcome }: { outcome: TicketOutcome }) {
  const theme = useTheme();
  return (
    <Card
      tone={
        outcome.kind === 'unknown' ? 'unknown' : outcome.kind === 'blocked' ? 'critical' : 'default'
      }
    >
      <Label size="lg" weight="semibold">
        {outcome.title}
      </Label>
      <Label size="sm" tone="secondary">
        {outcome.detail}
      </Label>
      <Pressable
        onPress={() => router.back()}
        style={{
          minHeight: theme.hit.comfortable,
          justifyContent: 'center',
          alignItems: 'center',
          borderRadius: theme.radius.md,
          backgroundColor: theme.color.surfaceRaised,
        }}
        accessibilityRole="button"
      >
        <Label weight="semibold">Done</Label>
      </Pressable>
    </Card>
  );
}

/**
 * UUIDv7: time-ordered, so intents sort by creation without a separate index,
 * and so a glance at an id tells you roughly when the decision was made.
 */
function makeUuidV7(): string {
  const ms = Date.now();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 6; i++) bytes[i] = (ms / 2 ** (8 * (5 - i))) & 0xff;
  const rand = new Uint8Array(10);
  for (let i = 0; i < 10; i++) rand[i] = Math.floor(Math.random() * 256);
  bytes.set(rand, 6);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
