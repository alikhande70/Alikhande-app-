import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { makeTheme } from '../src/design/tokens.js';

/**
 * Root layout.
 *
 * The order ticket is a modal presented over whatever the operator was looking
 * at, rather than a route they navigate to. That is deliberate: an order is
 * always taken *in the context of* a chart or a position, and pushing a screen
 * would lose that context and add a back-navigation step to cancelling.
 */
export default function RootLayout() {
  const scheme = useColorScheme();
  const theme = makeTheme(scheme === 'light' ? 'light' : 'dark');

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.color.canvas }}>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.color.canvas },
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="ticket"
          options={{
            presentation: 'modal',
            animation: 'slide_from_bottom',
            gestureEnabled: true,
          }}
        />
        <Stack.Screen name="pair" options={{ presentation: 'fullScreenModal' }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
