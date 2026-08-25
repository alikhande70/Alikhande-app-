import { useCallback } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Label, useTheme } from './primitives.js';

/**
 * The commit gesture.
 *
 * A tap is the wrong affordance for sending an order. Taps are what the
 * operator does all day, they happen by accident on a phone in one hand, and
 * there is no natural way to abandon one halfway. A slide is deliberate,
 * reversible right up to the end, and impossible to do by brushing the screen.
 *
 * Everything else about it is restraint: no bounce, no glow, no celebration.
 * The haptic at the commit point is the only feedback, and it is the same
 * warning haptic the system uses for consequential actions.
 */

export interface SlideToCommitProps {
  readonly label: string;
  readonly enabled: boolean;
  readonly side: 'buy' | 'sell';
  readonly onCommit: () => void | Promise<void>;
}

/** Fraction of the track that must be crossed. High enough to be deliberate. */
const COMMIT_THRESHOLD = 0.82;

export function SlideToCommit({ label, enabled, side, onCommit }: SlideToCommitProps) {
  const theme = useTheme();
  const trackWidth = useSharedValue(0);
  const knobX = useSharedValue(0);
  const committed = useSharedValue(false);

  const fire = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    void onCommit();
  }, [onCommit]);

  const reset = useCallback(() => {
    knobX.value = withSpring(0, { damping: 20, stiffness: 200 });
    committed.value = false;
  }, [knobX, committed]);

  const knobSize = theme.hit.commit - 8;

  const pan = Gesture.Pan()
    .enabled(enabled)
    .onUpdate((e) => {
      if (committed.value) return;
      const max = Math.max(0, trackWidth.value - knobSize - 8);
      knobX.value = Math.max(0, Math.min(max, e.translationX));
    })
    .onEnd(() => {
      const max = Math.max(1, trackWidth.value - knobSize - 8);
      if (knobX.value / max >= COMMIT_THRESHOLD) {
        committed.value = true;
        knobX.value = withTiming(max, { duration: 90 });
        runOnJS(fire)();
      } else {
        // Springs back. Abandoning is as easy as letting go, which is the
        // property that makes this safe to start exploring.
        knobX.value = withSpring(0, { damping: 20, stiffness: 200 });
      }
    });

  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: knobX.value }] }));
  const fillStyle = useAnimatedStyle(() => ({ width: knobX.value + knobSize }));

  const accent = side === 'buy' ? theme.color.long : theme.color.short;

  return (
    <View
      onLayout={(e) => {
        trackWidth.value = e.nativeEvent.layout.width;
      }}
      style={{
        height: theme.hit.commit,
        borderRadius: theme.radius.xl,
        backgroundColor: enabled ? theme.color.surfaceRaised : theme.color.surfaceSunken,
        borderWidth: 1,
        borderColor: enabled ? accent : theme.color.border,
        justifyContent: 'center',
        overflow: 'hidden',
        opacity: enabled ? 1 : 0.5,
      }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityHint="Slide right to send this order to your broker"
      accessibilityState={{ disabled: !enabled }}
      // VoiceOver cannot perform a pan, so the action is exposed directly.
      // Without this the screen is unusable with a screen reader, and the whole
      // point of the gesture is deliberateness, not inaccessibility.
      accessibilityActions={[{ name: 'activate', label: 'Send this order' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'activate' && enabled) fire();
      }}
    >
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            backgroundColor: side === 'buy' ? theme.color.longMuted : theme.color.shortMuted,
          },
          fillStyle,
        ]}
        pointerEvents="none"
      />
      <Label
        size="md"
        weight="semibold"
        tone={enabled ? 'default' : 'tertiary'}
        style={{ textAlign: 'center' }}
      >
        {label}
      </Label>
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            {
              position: 'absolute',
              left: 4,
              width: knobSize,
              height: knobSize,
              borderRadius: knobSize / 2,
              backgroundColor: enabled ? accent : theme.color.borderStrong,
              alignItems: 'center',
              justifyContent: 'center',
            },
            knobStyle,
          ]}
        >
          <Label size="lg" weight="bold" tone="default">
            →
          </Label>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

export { COMMIT_THRESHOLD };
