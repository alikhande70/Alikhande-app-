import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import { PairingError, pairDesk } from '../src/api/pairing.js';
import { getPairingRuntime } from '../src/api/pairing-runtime.js';
import { makeTheme, radius, space, type } from '../src/design/tokens.js';

type PairState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly detail: string }
  | { readonly kind: 'error'; readonly detail: string; readonly serverAccepted: boolean };

/**
 * First-time Desk pairing.
 *
 * This screen never generates key material itself and never claims that a key is
 * hardware-backed. A platform bootstrap must install a truthful SecureSigner in
 * `pairing-runtime` first. If it has not, the UI stays visibly blocked.
 */
export default function PairScreen() {
  const router = useRouter();
  const scheme = useColorScheme();
  const theme = makeTheme(scheme === 'light' ? 'light' : 'dark');
  const runtime = getPairingRuntime();
  const [deskUrl, setDeskUrl] = useState('');
  const [code, setCode] = useState('');
  const [state, setState] = useState<PairState>({ kind: 'idle' });

  const normalizedCode = useMemo(
    () =>
      code
        .replace(/[^0-9a-f]/gi, '')
        .toUpperCase()
        .slice(0, 10),
    [code],
  );
  const canSubmit =
    runtime !== undefined &&
    state.kind !== 'working' &&
    deskUrl.trim().length > 0 &&
    /^[0-9A-F]{10}$/.test(normalizedCode);

  async function submit(): Promise<void> {
    if (!canSubmit || runtime === undefined) return;
    setState({ kind: 'working', detail: 'Provisioning this device and contacting your Desk…' });
    try {
      await pairDesk(
        { baseUrl: deskUrl, code: normalizedCode },
        {
          signer: runtime.signer,
          store: runtime.store,
          startRuntime: runtime.startRuntime,
        },
      );
      router.replace('/(tabs)');
    } catch (error) {
      if (error instanceof PairingError) {
        setState({ kind: 'error', detail: error.message, serverAccepted: error.serverAccepted });
        return;
      }
      setState({
        kind: 'error',
        detail: error instanceof Error ? error.message : String(error),
        serverAccepted: false,
      });
    }
  }

  const status =
    runtime === undefined
      ? {
          title: 'Secure device signer unavailable',
          detail:
            'Pairing is blocked because this app build has not installed a verified device signer. ' +
            'No fallback key will be invented and no hardware-backed claim will be made.',
          color: theme.color.warning,
          background: theme.color.warningMuted,
        }
      : {
          title: 'Ready to pair',
          detail:
            'Use the Desk address and the 10-character enrolment code shown by your own Desk. ' +
            'The private device key never goes to the Desk.',
          color: theme.color.ok,
          background: theme.color.longMuted,
        };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.color.canvas }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{ padding: space.xl, paddingBottom: space.xxxl, gap: space.lg }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: space.xs }}>
          <Text
            style={{
              ...type.ui.xl,
              fontWeight: type.weight.semibold,
              color: theme.color.text,
            }}
          >
            Pair this device
          </Text>
          <Text style={{ ...type.ui.sm, color: theme.color.textSecondary }}>
            This creates a signed relationship between this phone and your personal trading Desk. It
            does not enable broker execution.
          </Text>
        </View>

        <View
          style={{
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: status.color,
            backgroundColor: status.background,
            padding: space.md,
            gap: space.xs,
          }}
        >
          <Text style={{ ...type.ui.sm, fontWeight: type.weight.semibold, color: status.color }}>
            {status.title}
          </Text>
          <Text style={{ ...type.ui.xs, color: theme.color.textSecondary }}>{status.detail}</Text>
        </View>

        <View style={{ gap: space.sm }}>
          <Text style={{ ...type.ui.sm, fontWeight: type.weight.medium, color: theme.color.text }}>
            Desk address
          </Text>
          <TextInput
            value={deskUrl}
            onChangeText={setDeskUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://192.168.1.10:8787"
            placeholderTextColor={theme.color.textTertiary}
            accessibilityLabel="Desk address"
            editable={state.kind !== 'working'}
            style={{
              minHeight: 52,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: theme.color.borderStrong,
              backgroundColor: theme.color.surface,
              color: theme.color.text,
              paddingHorizontal: space.md,
              ...type.ui.md,
            }}
          />
          <Text style={{ ...type.ui.xs, color: theme.color.textTertiary }}>
            Use only an address you control. Credentials embedded in the URL are rejected.
          </Text>
        </View>

        <View style={{ gap: space.sm }}>
          <Text style={{ ...type.ui.sm, fontWeight: type.weight.medium, color: theme.color.text }}>
            Enrolment code
          </Text>
          <TextInput
            value={normalizedCode}
            onChangeText={setCode}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={10}
            placeholder="A1B2C3D4E5"
            placeholderTextColor={theme.color.textTertiary}
            accessibilityLabel="Desk enrolment code"
            editable={state.kind !== 'working'}
            style={{
              minHeight: 52,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: theme.color.borderStrong,
              backgroundColor: theme.color.surface,
              color: theme.color.text,
              paddingHorizontal: space.md,
              letterSpacing: 1.5,
              ...type.numeric.md,
            }}
          />
          <Text style={{ ...type.ui.xs, color: theme.color.textTertiary }}>
            The code is only for enrolment. Do not paste passwords, broker credentials, or recovery
            codes here.
          </Text>
        </View>

        {state.kind === 'working' ? (
          <View
            style={{
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: theme.color.accent,
              backgroundColor: theme.color.accentMuted,
              padding: space.md,
            }}
          >
            <Text style={{ ...type.ui.sm, color: theme.color.text }}>{state.detail}</Text>
          </View>
        ) : null}

        {state.kind === 'error' ? (
          <View
            style={{
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: state.serverAccepted ? theme.color.unknown : theme.color.critical,
              backgroundColor: state.serverAccepted
                ? theme.color.unknownMuted
                : theme.color.criticalMuted,
              padding: space.md,
              gap: space.xs,
            }}
          >
            <Text
              style={{
                ...type.ui.sm,
                fontWeight: type.weight.semibold,
                color: state.serverAccepted ? theme.color.unknown : theme.color.critical,
              }}
            >
              {state.serverAccepted
                ? 'Desk accepted this key — do not enrol again'
                : 'Pairing failed'}
            </Text>
            <Text style={{ ...type.ui.xs, color: theme.color.textSecondary }}>{state.detail}</Text>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Pair this device to the Desk"
          disabled={!canSubmit}
          onPress={() => void submit()}
          style={({ pressed }) => ({
            minHeight: 56,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.md,
            backgroundColor: canSubmit ? theme.color.accent : theme.color.surfaceSunken,
            borderWidth: 1,
            borderColor: canSubmit ? theme.color.accent : theme.color.border,
            opacity: pressed && canSubmit ? 0.82 : 1,
            paddingHorizontal: space.lg,
          })}
        >
          <Text
            style={{
              ...type.ui.md,
              fontWeight: type.weight.semibold,
              color: canSubmit ? theme.color.textInverse : theme.color.textTertiary,
            }}
          >
            {state.kind === 'working' ? 'Pairing…' : 'Pair device'}
          </Text>
        </Pressable>

        <Text style={{ ...type.ui.xs, color: theme.color.textTertiary }}>
          Pairing only establishes authenticated app-to-Desk transport. Real-money execution stays
          disabled and MT5 order sending is not enabled by this screen.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
