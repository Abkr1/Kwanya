import { useMemo } from 'react';
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
    <NavThemeProvider value={navTheme}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: palette.bg },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="account" />
        <Stack.Screen name="auth/signin" />
        <Stack.Screen name="auth/signup" />
        <Stack.Screen name="auth/verify-phone" />
        <Stack.Screen name="auth/verify-email" />
      </Stack>
    </NavThemeProvider>
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
