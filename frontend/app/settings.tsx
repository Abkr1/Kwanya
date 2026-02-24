import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  BackHandler,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import axios from 'axios';
import { useAuth } from './_contexts/AuthContext';
import { useTheme } from './_contexts/ThemeContext';
import { useLanguage } from './_contexts/LanguageContext';
import { legalDocuments } from './_i18n/legal';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8001';

type Section = 'menu' | 'terms' | 'privacy' | 'language' | 'account';

export default function SettingsScreen() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, isAuthenticated, signOut, token } = useAuth();
  const { t, language, setLanguage } = useLanguage();
  const [section, setSection] = useState<Section>('menu');
  const [isDeleting, setIsDeleting] = useState(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: palette.bg,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: palette.border,
        },
        backButton: { padding: 4 },
        headerTitle: {
          fontSize: 20,
          fontWeight: '700',
          color: palette.text,
          marginLeft: 12,
        },
        scrollContent: { flex: 1 },
        menuSection: { paddingHorizontal: 20, paddingTop: 20 },
        menuItem: {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: palette.surface,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: palette.border,
          paddingHorizontal: 16,
          paddingVertical: 16,
          marginBottom: 10,
        },
        menuItemText: {
          flex: 1,
          fontSize: 16,
          fontWeight: '600',
          color: palette.text,
          marginLeft: 12,
        },
        documentContent: {
          paddingHorizontal: 20,
          paddingVertical: 16,
        },
        documentText: {
          fontSize: 14,
          lineHeight: 22,
          color: palette.text,
        },
        accountSection: { paddingHorizontal: 20, paddingTop: 20 },
        accountItem: {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: palette.surface,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: palette.border,
          paddingHorizontal: 16,
          paddingVertical: 16,
          marginBottom: 10,
        },
        accountItemDanger: {
          borderColor: '#FF3B30',
        },
        accountItemText: {
          flex: 1,
          fontSize: 16,
          fontWeight: '600',
          color: palette.text,
          marginLeft: 12,
        },
        accountItemTextDanger: {
          color: '#FF3B30',
        },
      }),
    [palette, insets],
  );

  const handleBack = useCallback(() => {
    if (section !== 'menu') {
      setSection('menu');
    } else {
      router.replace({ pathname: '/', params: { sidebar: '1' } });
    }
  }, [section, router]);

  useEffect(() => {
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      handleBack();
      return true;
    });
    return () => handler.remove();
  }, [handleBack]);

  const handleLogout = () => {
    Alert.alert(
      t('settings.logOut'),
      t('settings.logOutConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.logOut'),
          style: 'destructive',
          onPress: async () => {
            await signOut();
            router.replace('/');
          },
        },
      ],
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      t('settings.deleteAccount'),
      t('settings.deleteAccountMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              t('settings.absolutelySure'),
              t('settings.absolutelySureMessage'),
              [
                { text: t('common.cancel'), style: 'cancel' },
                {
                  text: t('settings.yesDelete'),
                  style: 'destructive',
                  onPress: async () => {
                    setIsDeleting(true);
                    try {
                      await axios.delete(`${BACKEND_URL}/api/auth/account`, {
                        headers: { Authorization: `Bearer ${token}` },
                      });
                      await signOut();
                      router.replace('/');
                    } catch {
                      Alert.alert(t('common.error'), t('settings.failedDelete'));
                    } finally {
                      setIsDeleting(false);
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  };

  const title =
    section === 'terms'
      ? t('settings.termsOfUse')
      : section === 'privacy'
        ? t('settings.privacyPolicy')
        : section === 'language'
          ? t('settings.language')
          : section === 'account'
            ? t('settings.accountSettings')
            : t('settings.title');

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={handleBack}>
          <Ionicons name="arrow-back" size={24} color={palette.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{title}</Text>
      </View>

      {section === 'menu' && (
        <View style={styles.menuSection}>
          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => setSection('terms')}
          >
            <Ionicons name="document-text-outline" size={22} color={palette.textMuted} />
            <Text style={styles.menuItemText}>{t('settings.termsOfUse')}</Text>
            <Ionicons name="chevron-forward" size={18} color={palette.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => setSection('privacy')}
          >
            <Ionicons name="shield-checkmark-outline" size={22} color={palette.textMuted} />
            <Text style={styles.menuItemText}>{t('settings.privacyPolicy')}</Text>
            <Ionicons name="chevron-forward" size={18} color={palette.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => setSection('language')}
          >
            <Ionicons name="globe-outline" size={22} color={palette.textMuted} />
            <Text style={styles.menuItemText}>{t('settings.language')}</Text>
            <Ionicons name="chevron-forward" size={18} color={palette.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => setSection('account')}
          >
            <Ionicons name="person-outline" size={22} color={palette.textMuted} />
            <Text style={styles.menuItemText}>{t('settings.accountSettings')}</Text>
            <Ionicons name="chevron-forward" size={18} color={palette.textMuted} />
          </TouchableOpacity>
        </View>
      )}

      {section === 'account' && (
        <View style={styles.accountSection}>
          <TouchableOpacity style={styles.accountItem} onPress={handleLogout}>
            <Ionicons name="log-out-outline" size={22} color={palette.text} />
            <Text style={styles.accountItemText}>{t('settings.logOut')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.accountItem, styles.accountItemDanger]}
            onPress={handleDeleteAccount}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <ActivityIndicator size="small" color="#FF3B30" />
            ) : (
              <Ionicons name="trash-outline" size={22} color="#FF3B30" />
            )}
            <Text style={[styles.accountItemText, styles.accountItemTextDanger]}>
              {t('settings.deleteAccount')}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {section === 'language' && (
        <View style={styles.accountSection}>
          <TouchableOpacity
            style={[styles.accountItem, language === 'en' && { borderColor: palette.button }]}
            onPress={() => setLanguage('en')}
          >
            <Ionicons name="language-outline" size={22} color={palette.text} />
            <Text style={styles.accountItemText}>{t('settings.english')}</Text>
            {language === 'en' && (
              <Ionicons name="checkmark-circle" size={22} color={palette.button} />
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.accountItem, language === 'ha' && { borderColor: palette.button }]}
            onPress={() => setLanguage('ha')}
          >
            <Ionicons name="language-outline" size={22} color={palette.text} />
            <Text style={styles.accountItemText}>{t('settings.hausa')}</Text>
            {language === 'ha' && (
              <Ionicons name="checkmark-circle" size={22} color={palette.button} />
            )}
          </TouchableOpacity>
        </View>
      )}

      {section === 'terms' && (
        <ScrollView
          style={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.documentContent}
        >
          <Text style={styles.documentText} selectable>
            {legalDocuments[language].termsOfUse}
          </Text>
        </ScrollView>
      )}

      {section === 'privacy' && (
        <ScrollView
          style={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.documentContent}
        >
          <Text style={styles.documentText} selectable>
            {legalDocuments[language].privacyPolicy}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}
