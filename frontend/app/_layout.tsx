import { Stack } from 'expo-router';
import { AuthProvider } from './_contexts/AuthContext';

export default function RootLayout() {
  return (
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
  );
}
