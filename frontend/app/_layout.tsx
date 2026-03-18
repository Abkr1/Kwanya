import { useMemo } from 'react';
import { View, StatusBar, Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { ThemeProvider as NavThemeProvider, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { AuthProvider } from './_contexts/AuthContext';
import { ThemeProvider, useTheme } from './_contexts/ThemeContext';
import { LanguageProvider } from './_contexts/LanguageContext';

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
        backgroundColor={Platform.OS === 'android' ? palette.bg : undefined}
        translucent={Platform.OS === 'android' ? false : undefined}
        animated
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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <AuthProvider>
          <LanguageProvider>
            <RootNavigator />
          </LanguageProvider>
        </AuthProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
