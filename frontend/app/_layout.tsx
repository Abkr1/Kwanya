import { Stack } from 'expo-router';
import { AuthProvider } from './_contexts/AuthContext';
import { ThemeProvider } from './_contexts/ThemeContext';

export default function RootLayout() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="account" />
          <Stack.Screen name="auth/signin" />
          <Stack.Screen name="auth/signup" />
          <Stack.Screen name="auth/verify-phone" />
          <Stack.Screen name="auth/verify-email" />
        </Stack>
      </AuthProvider>
    </ThemeProvider>
  );
}
