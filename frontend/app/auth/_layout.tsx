import { Stack } from 'expo-router';
import { useTheme } from '../_contexts/ThemeContext';

export default function AuthLayout() {
  const { palette } = useTheme();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: palette.bg },
        animation: 'fade',
      }}
    />
  );
}
