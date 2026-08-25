/**
 * The design system.
 *
 * Two ideas drive every decision here.
 *
 * **Numbers must not move.** A trading screen updates constantly. If digits are
 * proportionally spaced, every tick makes the whole row shimmy, and the operator
 * stops being able to read a price at a glance. Every numeric surface uses
 * tabular figures at a fixed width.
 *
 * **Certainty is a visual property, not a label.** A position the broker has
 * confirmed and one we merely think exists must be distinguishable across the
 * room, not by reading a status word. Colour, border and weight all carry it.
 *
 * What this deliberately is not: neon, gradients, glass, glow, or anything that
 * reads as a game. A tool used under stress should be quiet.
 */

export type Scheme = 'dark' | 'light';

/**
 * Dark is the default because that is when and where this is used — a phone at
 * a desk at 02:00, or in a dark room during the New York session.
 */
export const palette = {
  dark: {
    /** Not pure black: OLED smearing on scroll makes true black feel cheap. */
    canvas: '#0B0D10',
    surface: '#14171C',
    surfaceRaised: '#1B1F26',
    surfaceSunken: '#090A0D',
    border: '#252A33',
    borderStrong: '#39404D',

    text: '#E8EBF0',
    textSecondary: '#98A1B0',
    textTertiary: '#646D7C',
    textInverse: '#0B0D10',

    /** One accent, used only for the thing the operator should touch next. */
    accent: '#4C8DFF',
    accentMuted: '#1E3358',

    long: '#2FBF71',
    longMuted: '#123326',
    short: '#F0544F',
    shortMuted: '#3A1B1B',

    warning: '#E8A33D',
    warningMuted: '#3A2C14',
    critical: '#F0544F',
    criticalMuted: '#3A1B1B',
    /** Reserved for UNKNOWN state. Nothing else may use it. */
    unknown: '#C77DFF',
    unknownMuted: '#2B1C3A',
    ok: '#2FBF71',
  },
  light: {
    canvas: '#F7F8FA',
    surface: '#FFFFFF',
    surfaceRaised: '#FFFFFF',
    surfaceSunken: '#EDEFF3',
    border: '#DFE3EA',
    borderStrong: '#B9C0CC',

    text: '#11151B',
    textSecondary: '#4E5763',
    textTertiary: '#7C8593',
    textInverse: '#FFFFFF',

    accent: '#0B5FD9',
    accentMuted: '#DCE8FC',

    long: '#0E8A4A',
    longMuted: '#DCF2E6',
    short: '#C0332E',
    shortMuted: '#FBE3E2',

    warning: '#9A6410',
    warningMuted: '#FBEED6',
    critical: '#C0332E',
    criticalMuted: '#FBE3E2',
    unknown: '#7B3FBF',
    unknownMuted: '#EEE2FB',
    ok: '#0E8A4A',
  },
} as const;

export type Palette = (typeof palette)['dark'];

/**
 * Spacing on a 4pt grid. Trading screens are dense by necessity, so the scale
 * starts tight — but tap targets never do (see `hit`).
 */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

/**
 * Minimum interactive sizes. 44pt is Apple's floor; anything that can send an
 * order gets more, because a mis-tap there is not a mis-tap, it is a position.
 */
export const hit = {
  min: 44,
  comfortable: 52,
  /** Order-committing controls. */
  commit: 64,
} as const;

export const type = {
  /** UI text. System font: it is what the operator's eye is calibrated to. */
  ui: {
    xs: { fontSize: 11, lineHeight: 14, letterSpacing: 0.2 },
    sm: { fontSize: 13, lineHeight: 18 },
    md: { fontSize: 15, lineHeight: 20 },
    lg: { fontSize: 17, lineHeight: 22 },
    xl: { fontSize: 22, lineHeight: 28, letterSpacing: -0.2 },
    display: { fontSize: 34, lineHeight: 40, letterSpacing: -0.6 },
  },
  /**
   * Every number in the app. Tabular figures at a fixed advance width, so a
   * price ticking from 2400.09 to 2400.10 does not shift the layout.
   */
  numeric: {
    fontVariant: ['tabular-nums'] as const,
    xs: { fontSize: 11, lineHeight: 14 },
    sm: { fontSize: 13, lineHeight: 17 },
    md: { fontSize: 16, lineHeight: 20 },
    lg: { fontSize: 20, lineHeight: 24, letterSpacing: -0.2 },
    xl: { fontSize: 28, lineHeight: 32, letterSpacing: -0.4 },
    display: { fontSize: 40, lineHeight: 44, letterSpacing: -1 },
  },
  weight: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
  },
} as const;

/**
 * How each certainty level looks.
 *
 * This mapping is the visual half of the promise that the app never shows an
 * unconfirmed thing as confirmed. It is defined once, here, so no screen can
 * quietly render an UNKNOWN order in the ordinary style.
 */
export type Certainty = 'confirmed' | 'in-flight' | 'unknown' | 'local';

export interface CertaintyStyle {
  readonly borderStyle: 'solid' | 'dashed';
  readonly borderWidth: number;
  readonly opacity: number;
  readonly colorKey: keyof Palette;
  readonly backgroundKey: keyof Palette;
  /** Short word shown alongside. Never omitted for anything but `confirmed`. */
  readonly badge?: string;
}

export const certaintyStyles: Readonly<Record<Certainty, CertaintyStyle>> = {
  confirmed: {
    borderStyle: 'solid',
    borderWidth: 1,
    opacity: 1,
    colorKey: 'text',
    backgroundKey: 'surface',
  },
  'in-flight': {
    // Dashed, because "we have sent this and not heard back" is genuinely
    // provisional and should look provisional at a glance.
    borderStyle: 'dashed',
    borderWidth: 1,
    opacity: 1,
    colorKey: 'textSecondary',
    backgroundKey: 'surface',
    badge: 'SENT',
  },
  unknown: {
    // The one state with its own colour. It has to be impossible to mistake
    // for anything else, because the correct response to it is "do nothing".
    borderStyle: 'solid',
    borderWidth: 2,
    opacity: 1,
    colorKey: 'unknown',
    backgroundKey: 'unknownMuted',
    badge: 'UNKNOWN',
  },
  local: {
    borderStyle: 'dashed',
    borderWidth: 1,
    opacity: 0.7,
    colorKey: 'textTertiary',
    backgroundKey: 'surfaceSunken',
    badge: 'NOT SENT',
  },
};

/** Freshness colours for the age badge that sits beside every live number. */
export type Freshness = 'live' | 'aging' | 'stale';

export const freshnessColorKey: Readonly<Record<Freshness, keyof Palette>> = {
  live: 'textTertiary',
  aging: 'warning',
  stale: 'critical',
};

/**
 * Motion.
 *
 * Deliberately minimal. The only animations that earn their place are ones that
 * preserve continuity (a sheet arriving from where it was summoned) or that
 * signal a state the operator must not miss. Nothing decorative.
 */
export const motion = {
  /** Sheets, navigation. */
  standard: { duration: 220 },
  /** Value changes. Short enough not to lag the market. */
  value: { duration: 120 },
  /** A number that just changed flashes its direction, then settles. */
  tickFlash: { duration: 320 },
  /** Respect the platform setting; this is checked before any animation runs. */
  reducedMotionFallbackDuration: 0,
} as const;

export const elevation = {
  sheet: {
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
  },
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
} as const;

export interface Theme {
  readonly scheme: Scheme;
  readonly color: Palette;
  readonly space: typeof space;
  readonly radius: typeof radius;
  readonly type: typeof type;
  readonly hit: typeof hit;
  readonly motion: typeof motion;
  readonly elevation: typeof elevation;
}

export function makeTheme(scheme: Scheme): Theme {
  return {
    scheme,
    color: palette[scheme],
    space,
    radius,
    type,
    hit,
    motion,
    elevation,
  };
}

/** Side colour, used consistently everywhere a direction is shown. */
export function sideColor(theme: Theme, side: 'buy' | 'sell'): string {
  return side === 'buy' ? theme.color.long : theme.color.short;
}

/**
 * P&L colour.
 *
 * Zero is deliberately neutral rather than green: a flat position is not a win,
 * and colouring it as one is the kind of small dishonesty that adds up.
 */
export function pnlColor(theme: Theme, sign: -1 | 0 | 1): string {
  if (sign === 0) return theme.color.textSecondary;
  return sign > 0 ? theme.color.long : theme.color.short;
}
