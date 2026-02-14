import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const THEME_STORAGE_KEY = 'themePreference';

type ThemePref = 'light' | 'dark' | 'system';

interface ThemeContextType {
  themePreference: ThemePref;
  isDark: boolean;
  setThemePreference: (pref: ThemePref) => void;
  palette: {
    bg: string;
    surface: string;
    surfaceAlt: string;
    text: string;
    textMuted: string;
    textSubtle: string;
    border: string;
    overlay: string;
    button: string;
    buttonText: string;
    disabled: string;
    error: string;
    google: string;
    danger: string;
    dangerBg: string;
    success: string;
    accent: string;
    accentText: string;
    userBubble: string;
    userBubbleText: string;
    assistantBubble: string;
  };
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const colorScheme = useColorScheme();
  const [themePreference, setThemePrefState] = useState<ThemePref>('system');

  const isDark = themePreference === 'system' ? colorScheme === 'dark' : themePreference === 'dark';

  useEffect(() => {
    const load = async () => {
      try {
        const stored = await AsyncStorage.getItem(THEME_STORAGE_KEY);
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          setThemePrefState(stored);
        }
      } catch (error) {
        console.error('Failed to load theme preference:', error);
      }
    };
    load();
  }, []);

  const setThemePreference = useCallback(async (pref: ThemePref) => {
    setThemePrefState(pref);
    try {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, pref);
    } catch (error) {
      console.error('Failed to save theme preference:', error);
    }
  }, []);

  const palette = useMemo(() => ({
    bg: isDark ? '#1A1816' : '#F4F3EE',
    surface: isDark ? '#242220' : '#EEEDE7',
    surfaceAlt: isDark ? '#2E2B28' : '#E8E6DF',
    text: isDark ? '#F4F3EE' : '#1A1816',
    textMuted: isDark ? '#B8B3A8' : '#5D5A53',
    textSubtle: isDark ? '#7D786F' : '#8C8880',
    border: isDark ? '#3A3632' : '#D9D6CE',
    overlay: 'rgba(0,0,0,0.55)',
    button: isDark ? '#D4764E' : '#C15F3C',
    buttonText: '#FFFFFF',
    disabled: isDark ? '#3A3632' : '#D4D1C9',
    error: '#e53935',
    google: '#4285F4',
    danger: '#e53935',
    dangerBg: isDark ? '#2D1F1A' : '#fef2f2',
    success: '#43a047',
    accent: isDark ? '#D4764E' : '#C15F3C',
    accentText: '#FFFFFF',
    userBubble: isDark ? '#D4764E' : '#C15F3C',
    userBubbleText: '#FFFFFF',
    assistantBubble: isDark ? '#2E2B28' : '#EEEDE7',
  }), [isDark]);

  return (
    <ThemeContext.Provider value={{ themePreference, isDark, setThemePreference, palette }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
