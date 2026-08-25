import type { ReactNode } from 'react';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { Text, useColorScheme, View } from 'react-native';
import type { Certainty, Freshness, Theme } from '../design/tokens.js';
import { certaintyStyles, freshnessColorKey, makeTheme, pnlColor } from '../design/tokens.js';

/**
 * The primitives every screen is built from.
 *
 * They exist so that the two rules that matter cannot be forgotten by a screen
 * written in a hurry:
 *
 * - a number is always rendered with tabular figures, so rows do not shimmy;
 * - anything that could be stale or unconfirmed carries its own badge, so no
 *   screen can accidentally present it as current and confirmed.
 */

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return makeTheme(scheme === 'light' ? 'light' : 'dark');
}

// ---------------------------------------------------------------------------

export interface NumericProps {
  readonly value: string;
  readonly size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'display';
  readonly tone?: 'default' | 'secondary' | 'tertiary' | 'long' | 'short' | 'warning' | 'critical';
  readonly weight?: 'regular' | 'medium' | 'semibold' | 'bold';
  readonly style?: StyleProp<TextStyle>;
}

/**
 * Every number in the app goes through here.
 *
 * `fontVariant: tabular-nums` is the whole point: without it, a price ticking
 * from 2400.09 to 2400.11 changes the width of the row, and the operator's eye
 * has to re-find the digits on every update.
 */
export function Numeric({
  value,
  size = 'md',
  tone = 'default',
  weight = 'medium',
  style,
}: NumericProps): ReactNode {
  const theme = useTheme();
  const toneColor: Record<NonNullable<NumericProps['tone']>, string> = {
    default: theme.color.text,
    secondary: theme.color.textSecondary,
    tertiary: theme.color.textTertiary,
    long: theme.color.long,
    short: theme.color.short,
    warning: theme.color.warning,
    critical: theme.color.critical,
  };
  return (
    <Text
      style={[
        theme.type.numeric[size],
        {
          fontVariant: ['tabular-nums'],
          color: toneColor[tone],
          fontWeight: theme.type.weight[weight],
        },
        style,
      ]}
      // Numbers must never wrap or ellipsise mid-value: a truncated price is
      // worse than no price.
      numberOfLines={1}
      allowFontScaling
      maxFontSizeMultiplier={1.4}
    >
      {value}
    </Text>
  );
}

export interface LabelProps {
  readonly children: ReactNode;
  readonly size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'display';
  readonly tone?: 'default' | 'secondary' | 'tertiary' | 'accent' | 'critical' | 'warning';
  readonly weight?: 'regular' | 'medium' | 'semibold' | 'bold';
  readonly style?: StyleProp<TextStyle>;
  readonly numberOfLines?: number;
}

export function Label({
  children,
  size = 'md',
  tone = 'default',
  weight = 'regular',
  style,
  numberOfLines,
}: LabelProps): ReactNode {
  const theme = useTheme();
  const toneColor: Record<NonNullable<LabelProps['tone']>, string> = {
    default: theme.color.text,
    secondary: theme.color.textSecondary,
    tertiary: theme.color.textTertiary,
    accent: theme.color.accent,
    critical: theme.color.critical,
    warning: theme.color.warning,
  };
  return (
    <Text
      style={[
        theme.type.ui[size],
        { color: toneColor[tone], fontWeight: theme.type.weight[weight] },
        style,
      ]}
      {...(numberOfLines !== undefined ? { numberOfLines } : {})}
      allowFontScaling
      maxFontSizeMultiplier={1.4}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------

export interface AgeBadgeProps {
  readonly ageMs: number | undefined;
  readonly freshness: Freshness;
}

/**
 * The age of a value, always shown next to it.
 *
 * A spinner says "loading", which is a lie when the truth is "this is four
 * minutes old and the feed may be dead". This says the number.
 */
export function AgeBadge({ ageMs, freshness }: AgeBadgeProps): ReactNode {
  const theme = useTheme();
  if (ageMs === undefined) {
    return (
      <Label size="xs" tone="tertiary">
        no data
      </Label>
    );
  }
  const color = theme.color[freshnessColorKey[freshness]];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.xxs }}>
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: color,
        }}
        accessibilityElementsHidden
      />
      <Text
        style={{
          ...theme.type.numeric.xs,
          fontVariant: ['tabular-nums'],
          color,
        }}
        accessibilityLabel={`data is ${describeAge(ageMs)} old, ${freshness}`}
      >
        {describeAge(ageMs)}
      </Text>
    </View>
  );
}

export function describeAge(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

// ---------------------------------------------------------------------------

export interface CertaintyChipProps {
  readonly certainty: Certainty;
  readonly text?: string;
}

/**
 * The badge that makes an unconfirmed thing look unconfirmed.
 *
 * `confirmed` renders nothing at all — the absence of a badge is the signal,
 * and adding a green "CONFIRMED" tick everywhere would train the eye to ignore
 * the row where it matters.
 */
export function CertaintyChip({ certainty, text }: CertaintyChipProps): ReactNode {
  const theme = useTheme();
  const style = certaintyStyles[certainty];
  if (style.badge === undefined) return null;
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        paddingHorizontal: theme.space.sm,
        paddingVertical: theme.space.xxs,
        borderRadius: theme.radius.sm,
        backgroundColor: theme.color[style.backgroundKey],
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        borderColor: theme.color[style.colorKey],
      }}
      accessibilityRole="text"
      accessibilityLabel={text ?? style.badge}
    >
      <Text
        style={{
          ...theme.type.ui.xs,
          color: theme.color[style.colorKey],
          fontWeight: theme.type.weight.semibold,
          letterSpacing: 0.6,
        }}
      >
        {style.badge}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------

export interface CardProps {
  readonly children: ReactNode;
  readonly tone?: 'default' | 'warning' | 'critical' | 'unknown';
  readonly style?: StyleProp<ViewStyle>;
}

export function Card({ children, tone = 'default', style }: CardProps): ReactNode {
  const theme = useTheme();
  const borders: Record<NonNullable<CardProps['tone']>, string> = {
    default: theme.color.border,
    warning: theme.color.warning,
    critical: theme.color.critical,
    unknown: theme.color.unknown,
  };
  const backgrounds: Record<NonNullable<CardProps['tone']>, string> = {
    default: theme.color.surface,
    warning: theme.color.warningMuted,
    critical: theme.color.criticalMuted,
    unknown: theme.color.unknownMuted,
  };
  return (
    <View
      style={[
        {
          backgroundColor: backgrounds[tone],
          borderColor: borders[tone],
          borderWidth: tone === 'default' ? 1 : 1.5,
          borderRadius: theme.radius.lg,
          padding: theme.space.lg,
          gap: theme.space.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export interface RowProps {
  readonly children: ReactNode;
  readonly gap?: number;
  readonly align?: 'flex-start' | 'center' | 'flex-end' | 'baseline';
  readonly justify?: 'flex-start' | 'center' | 'flex-end' | 'space-between';
  readonly style?: StyleProp<ViewStyle>;
}

export function Row({
  children,
  gap,
  align = 'center',
  justify = 'flex-start',
  style,
}: RowProps): ReactNode {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: align,
          justifyContent: justify,
          gap: gap ?? theme.space.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A P&L figure, coloured by sign, with zero deliberately neutral. */
export function Pnl({
  value,
  size = 'md',
}: {
  value: string;
  size?: NumericProps['size'];
}): ReactNode {
  const theme = useTheme();
  const n = Number(value);
  const sign: -1 | 0 | 1 = Number.isFinite(n) ? (n > 0 ? 1 : n < 0 ? -1 : 0) : 0;
  const prefix = sign > 0 ? '+' : '';
  return (
    <Text
      style={{
        ...theme.type.numeric[size],
        fontVariant: ['tabular-nums'],
        color: pnlColor(theme, sign),
        fontWeight: theme.type.weight.semibold,
      }}
      numberOfLines={1}
    >
      {prefix}
      {value}
    </Text>
  );
}
