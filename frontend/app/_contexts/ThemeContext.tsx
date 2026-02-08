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
    bg: isDark ? '#000000' : '#ffffff',
    surface: isDark ? '#0d0d0d' : '#f7f7f7',
    surfaceAlt: isDark ? '#151515' : '#f2f2f2',
    text: isDark ? '#ffffff' : '#000000',
    textMuted: isDark ? '#c7c7c7' : '#333333',
    textSubtle: isDark ? '#9a9a9a' : '#666666',
    border: isDark ? '#2a2a2a' : '#e5e5e5',
    overlay: 'rgba(0,0,0,0.55)',
    button: isDark ? '#ffffff' : '#000000',
    buttonText: isDark ? '#000000' : '#ffffff',
    disabled: isDark ? '#2f2f2f' : '#d9d9d9',
    error: '#e53935',
    google: '#4285F4',
    danger: '#e53935',
    dangerBg: isDark ? '#2d1111' : '#fef2f2',
    success: '#43a047',
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
