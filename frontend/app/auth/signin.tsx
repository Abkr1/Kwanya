import React, { useState, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  ScrollView,
  ActivityIndicator,
  Alert,
  Modal,
  FlatList,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '../_contexts/AuthContext';
import { useTheme } from '../_contexts/ThemeContext';
import { useLanguage } from '../_contexts/LanguageContext';

type SigninMode = 'phone' | 'email';

interface CountryCode {
  name: string;
  dial: string;
  flag: string;
}

const COUNTRY_CODES: CountryCode[] = [
  { name: 'Nigeria', dial: '+234', flag: '\u{1F1F3}\u{1F1EC}' },
  { name: 'Ghana', dial: '+233', flag: '\u{1F1EC}\u{1F1ED}' },
  { name: 'Niger', dial: '+227', flag: '\u{1F1F3}\u{1F1EA}' },
  { name: 'Cameroon', dial: '+237', flag: '\u{1F1E8}\u{1F1F2}' },
  { name: 'Chad', dial: '+235', flag: '\u{1F1F9}\u{1F1E9}' },
  { name: 'Benin', dial: '+229', flag: '\u{1F1E7}\u{1F1EF}' },
  { name: 'Togo', dial: '+228', flag: '\u{1F1F9}\u{1F1EC}' },
  { name: 'Senegal', dial: '+221', flag: '\u{1F1F8}\u{1F1F3}' },
  { name: 'Ivory Coast', dial: '+225', flag: '\u{1F1E8}\u{1F1EE}' },
  { name: 'South Africa', dial: '+27', flag: '\u{1F1FF}\u{1F1E6}' },
  { name: 'Kenya', dial: '+254', flag: '\u{1F1F0}\u{1F1EA}' },
  { name: 'Tanzania', dial: '+255', flag: '\u{1F1F9}\u{1F1FF}' },
  { name: 'Egypt', dial: '+20', flag: '\u{1F1EA}\u{1F1EC}' },
  { name: 'Morocco', dial: '+212', flag: '\u{1F1F2}\u{1F1E6}' },
  { name: 'United Kingdom', dial: '+44', flag: '\u{1F1EC}\u{1F1E7}' },
  { name: 'United States', dial: '+1', flag: '\u{1F1FA}\u{1F1F8}' },
  { name: 'Canada', dial: '+1', flag: '\u{1F1E8}\u{1F1E6}' },
  { name: 'India', dial: '+91', flag: '\u{1F1EE}\u{1F1F3}' },
  { name: 'Saudi Arabia', dial: '+966', flag: '\u{1F1F8}\u{1F1E6}' },
  { name: 'UAE', dial: '+971', flag: '\u{1F1E6}\u{1F1EA}' },
  { name: 'Germany', dial: '+49', flag: '\u{1F1E9}\u{1F1EA}' },
  { name: 'France', dial: '+33', flag: '\u{1F1EB}\u{1F1F7}' },
  { name: 'Brazil', dial: '+55', flag: '\u{1F1E7}\u{1F1F7}' },
  { name: 'China', dial: '+86', flag: '\u{1F1E8}\u{1F1F3}' },
  { name: 'Japan', dial: '+81', flag: '\u{1F1EF}\u{1F1F5}' },
  { name: 'Australia', dial: '+61', flag: '\u{1F1E6}\u{1F1FA}' },
];

export default function SigninScreen() {
  const { palette } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signIn } = useAuth();

  const [mode, setMode] = useState<SigninMode>('phone');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [selectedCountry, setSelectedCountry] = useState<CountryCode>(COUNTRY_CODES[0]);
  const [countryPickerVisible, setCountryPickerVisible] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const [pin, setPin] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);

  const filteredCountries = useMemo(() => {
    if (!countrySearch.trim()) return COUNTRY_CODES;
    const q = countrySearch.toLowerCase();
    return COUNTRY_CODES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.dial.includes(q),
    );
  }, [countrySearch]);

  const handleSignin = async () => {
    let identifier: string;
    if (mode === 'phone') {
      if (!phone.trim()) {
        Alert.alert(t('common.error'), t('signin.enterPhone'));
        return;
      }
      identifier = selectedCountry.dial + phone.trim().replace(/^0+/, '');
    } else {
      if (!email.trim()) {
        Alert.alert(t('common.error'), t('signin.enterEmail'));
        return;
      }
      identifier = email.trim();
    }
    if (!pin.trim()) {
      Alert.alert(t('common.error'), t('signin.enterPassword'));
      return;
    }

    setIsLoading(true);
    const result = await signIn(identifier, pin);
    setIsLoading(false);

    if (result.success) {
      router.replace('/');
    } else {
      Alert.alert(t('signin.signInFailed'), result.error || t('signin.invalidCredentials'));
    }
  };

  const styles = useMemo(() => StyleSheet.create({
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
    backButton: {
      padding: 4,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: palette.text,
      marginLeft: 12,
    },
    scrollContent: {
      flex: 1,
      paddingHorizontal: 24,
    },
    titleSection: {
      alignItems: 'center',
      marginTop: 40,
      marginBottom: 32,
    },
    iconCircle: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: palette.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 16,
      borderWidth: 1,
      borderColor: palette.border,
    },
    title: {
      fontSize: 28,
      fontWeight: '700',
      color: palette.text,
      marginBottom: 8,
    },
    subtitle: {
      fontSize: 15,
      color: palette.textSubtle,
      textAlign: 'center',
    },
    modeToggle: {
      flexDirection: 'row',
      marginBottom: 24,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: palette.border,
      overflow: 'hidden',
    },
    modeButton: {
      flex: 1,
      paddingVertical: 12,
      alignItems: 'center',
      backgroundColor: palette.bg,
    },
    modeButtonActive: {
      backgroundColor: palette.button,
    },
    modeButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textMuted,
    },
    modeButtonTextActive: {
      color: palette.buttonText,
    },
    inputGroup: {
      marginBottom: 16,
    },
    inputLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textMuted,
      marginBottom: 8,
    },
    inputWrapper: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: palette.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: 14,
    },
    inputIcon: {
      marginRight: 10,
    },
    input: {
      flex: 1,
      height: 48,
      fontSize: 16,
      color: palette.text,
    },
    phoneRow: {
      flexDirection: 'row',
      gap: 8,
    },
    countryCodeButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: palette.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: 12,
      height: 48,
      gap: 6,
    },
    countryFlag: {
      fontSize: 18,
    },
    countryDial: {
      fontSize: 15,
      fontWeight: '600',
      color: palette.text,
    },
    phoneInput: {
      flex: 1,
      height: 48,
      fontSize: 16,
      color: palette.text,
      backgroundColor: palette.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: 14,
    },
    forgotPasswordText: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textSubtle,
      textAlign: 'right',
      marginBottom: 8,
      marginTop: 4,
    },
    signinButton: {
      backgroundColor: palette.button,
      borderRadius: 12,
      paddingVertical: 16,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 8,
      marginBottom: 16,
    },
    signinButtonDisabled: {
      backgroundColor: palette.disabled,
    },
    signinButtonText: {
      fontSize: 16,
      fontWeight: '700',
      color: palette.buttonText,
    },
    signupLink: {
      flexDirection: 'row',
      justifyContent: 'center',
      paddingVertical: 20,
    },
    signupText: {
      fontSize: 15,
      color: palette.textSubtle,
    },
    signupTextBold: {
      fontSize: 15,
      fontWeight: '700',
      color: palette.text,
    },
    pickerOverlay: {
      flex: 1,
      backgroundColor: palette.overlay,
      justifyContent: 'flex-end',
    },
    pickerContainer: {
      backgroundColor: palette.bg,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      maxHeight: '70%',
      paddingBottom: insets.bottom,
    },
    pickerHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: palette.border,
    },
    pickerTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: palette.text,
    },
    pickerSearchWrapper: {
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    pickerSearchInput: {
      backgroundColor: palette.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 15,
      color: palette.text,
    },
    pickerItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: palette.border,
    },
    pickerItemSelected: {
      backgroundColor: palette.surfaceAlt,
    },
    pickerItemFlag: {
      fontSize: 22,
      marginRight: 12,
    },
    pickerItemName: {
      flex: 1,
      fontSize: 15,
      color: palette.text,
    },
    pickerItemDial: {
      fontSize: 15,
      color: palette.textSubtle,
      fontWeight: '500',
    },
    pickerItemCheck: {
      marginLeft: 8,
    },
  }), [palette, insets]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={palette.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('signin.title')}</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={insets.top}
      >
        <ScrollView
          ref={scrollViewRef}
          style={styles.scrollContent}
          contentContainerStyle={{ flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.titleSection}>
            <View style={styles.iconCircle}>
              <Ionicons name="log-in-outline" size={36} color={palette.text} />
            </View>
            <Text style={styles.title}>{t('signin.heading')}</Text>
            <Text style={styles.subtitle}>{t('signin.subtitle')}</Text>
          </View>

          {/* Mode Toggle */}
          <View style={styles.modeToggle}>
            <TouchableOpacity
              style={[styles.modeButton, mode === 'phone' && styles.modeButtonActive]}
              onPress={() => setMode('phone')}
            >
              <Text style={[styles.modeButtonText, mode === 'phone' && styles.modeButtonTextActive]}>
                {t('signin.phoneNumber')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeButton, mode === 'email' && styles.modeButtonActive]}
              onPress={() => setMode('email')}
            >
              <Text style={[styles.modeButtonText, mode === 'email' && styles.modeButtonTextActive]}>
                {t('signin.emailTab')}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Phone or Email input */}
          {mode === 'phone' ? (
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>{t('signin.phoneNumber')}</Text>
              <View style={styles.phoneRow}>
                <TouchableOpacity
                  style={styles.countryCodeButton}
                  onPress={() => setCountryPickerVisible(true)}
                >
                  <Text style={styles.countryFlag}>{selectedCountry.flag}</Text>
                  <Text style={styles.countryDial}>{selectedCountry.dial}</Text>
                  <Ionicons name="chevron-down" size={14} color={palette.textSubtle} />
                </TouchableOpacity>
                <TextInput
                  style={styles.phoneInput}
                  placeholder="801 234 5678"
                  placeholderTextColor={palette.textSubtle}
                  value={phone}
                  onChangeText={setPhone}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                />
              </View>
            </View>
          ) : (
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>{t('signin.emailAddress')}</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="mail-outline" size={20} color={palette.textSubtle} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="you@example.com"
                  placeholderTextColor={palette.textSubtle}
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                />
              </View>
            </View>
          )}

          {/* PIN */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>{t('signin.password')}</Text>
            <View style={styles.inputWrapper}>
              <Ionicons name="lock-closed-outline" size={20} color={palette.textSubtle} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder={t('signin.passwordPlaceholder')}
                placeholderTextColor={palette.textSubtle}
                value={pin}
                onChangeText={setPin}
                secureTextEntry
                keyboardType="number-pad"
                maxLength={4}
                onFocus={() => {
                  setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 300);
                }}
              />
            </View>
          </View>

          {/* Forgot Password */}
          <TouchableOpacity onPress={() => router.push('/auth/forgot-password')}>
            <Text style={styles.forgotPasswordText}>{t('signin.forgotPassword')}</Text>
          </TouchableOpacity>

          {/* Sign In Button */}
          <TouchableOpacity
            style={[styles.signinButton, isLoading && styles.signinButtonDisabled]}
            onPress={handleSignin}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={palette.buttonText} />
            ) : (
              <Text style={styles.signinButtonText}>{t('signin.title')}</Text>
            )}
          </TouchableOpacity>

          {/* Sign up link */}
          <TouchableOpacity style={styles.signupLink} onPress={() => router.replace('/auth/signup')}>
            <Text style={styles.signupText}>{t('signin.dontHaveAccount')}</Text>
            <Text style={styles.signupTextBold}>{t('common.signUp')}</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Country Code Picker Modal */}
      <Modal
        visible={countryPickerVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setCountryPickerVisible(false)}
      >
        <View style={styles.pickerOverlay}>
          <View style={styles.pickerContainer}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>{t('signin.selectCountry')}</Text>
              <TouchableOpacity onPress={() => {
                setCountryPickerVisible(false);
                setCountrySearch('');
              }}>
                <Ionicons name="close" size={24} color={palette.text} />
              </TouchableOpacity>
            </View>
            <View style={styles.pickerSearchWrapper}>
              <TextInput
                style={styles.pickerSearchInput}
                placeholder={t('signin.searchCountry')}
                placeholderTextColor={palette.textSubtle}
                value={countrySearch}
                onChangeText={setCountrySearch}
                autoCapitalize="none"
              />
            </View>
            <FlatList
              data={filteredCountries}
              keyExtractor={(item) => item.name + item.dial}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[
                    styles.pickerItem,
                    item.dial === selectedCountry.dial && item.name === selectedCountry.name && styles.pickerItemSelected,
                  ]}
                  onPress={() => {
                    setSelectedCountry(item);
                    setCountryPickerVisible(false);
                    setCountrySearch('');
                  }}
                >
                  <Text style={styles.pickerItemFlag}>{item.flag}</Text>
                  <Text style={styles.pickerItemName}>{item.name}</Text>
                  <Text style={styles.pickerItemDial}>{item.dial}</Text>
                  {item.dial === selectedCountry.dial && item.name === selectedCountry.name && (
                    <Ionicons name="checkmark" size={18} color={palette.text} style={styles.pickerItemCheck} />
                  )}
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}
