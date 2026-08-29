import { Tabs } from 'expo-router';
import { useColorScheme } from 'react-native';
import { makeTheme } from '../../src/design/tokens.js';

/**
 * Four tabs, and no more.
 *
 * Traders do not think in menus; they think in outcomes. Every tab here answers
 * a question the operator actually asks:
 *
 *   Pulse     — what is going on right now, and is anything wrong?
 *   Trade     — the chart, and the only place an order can be started.
 *   Book      — what am I actually holding, and is it protected?
 *   Review    — what have I been doing, and is it working?
 *
 * Risk configuration and diagnostics live behind Pulse rather than as tabs of
 * their own: they are consulted, not navigated.
 */
export default function TabsLayout() {
  const scheme = useColorScheme();
  const theme = makeTheme(scheme === 'light' ? 'light' : 'dark');

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.color.accent,
        tabBarInactiveTintColor: theme.color.textTertiary,
        tabBarStyle: {
          backgroundColor: theme.color.surface,
          borderTopColor: theme.color.border,
          // Tall enough to hit with a thumb without looking.
          height: 88,
          paddingTop: 8,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Pulse' }} />
      <Tabs.Screen name="trade" options={{ title: 'Trade' }} />
      <Tabs.Screen name="book" options={{ title: 'Book' }} />
      <Tabs.Screen name="review" options={{ title: 'Review' }} />
    </Tabs>
  );
}
