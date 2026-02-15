import { View } from 'react-native';
import { Stack } from 'expo-router';
import { useTheme } from '../_contexts/ThemeContext';

export default function AuthLayout() {
  const { palette } = useTheme();

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: palette.bg },
          animation: 'none',
          freezeOnBlur: true,
        }}
      />
    </View>
  );
}
