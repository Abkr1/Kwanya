import { useMemo } from 'react';
import { View, StatusBar } from 'react-native';
import { Stack } from 'expo-router';
import { ThemeProvider as NavThemeProvider, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { AuthProvider } from './_contexts/AuthContext';
import { ThemeProvider, useTheme } from './_contexts/ThemeContext';

function RootNavigator() {
  const { isDark, palette } = useTheme();

  const navTheme = useMemo(() => ({
    ...(isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(isDark ? DarkTheme.colors : DefaultTheme.colors),
      background: palette.bg,
      card: palette.bg,
      border: palette.border,
      text: palette.text,
      primary: palette.accent,
    },
  }), [isDark, palette]);

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={palette.bg}
        translucent={false}
      />
      <NavThemeProvider value={navTheme}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: palette.bg },
            animation: 'none',
            freezeOnBlur: true,
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="account" />
          <Stack.Screen name="credits" />
          <Stack.Screen name="auth" />
        </Stack>
      </NavThemeProvider>
    </View>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </ThemeProvider>
  );
}
