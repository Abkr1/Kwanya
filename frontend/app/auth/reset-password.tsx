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
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../_contexts/AuthContext';
import { useTheme } from '../_contexts/ThemeContext';
import { useLanguage } from '../_contexts/LanguageContext';

const CODE_LENGTH = 6;

export default function ResetPasswordScreen() {
  const { palette } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { identifier, method } = useLocalSearchParams<{ identifier: string; method: string }>();
  const { resetPassword, requestPasswordReset } = useAuth();

  const [code, setCode] = useState<string[]>(new Array(CODE_LENGTH).fill(''));
  const [newPin, setNewPin] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const inputRefs = useRef<(TextInput | null)[]>([]);

  const handleCodeChange = (value: string, index: number) => {
    if (value.length > 1) {
      const digits = value.replace(/\D/g, '').split('').slice(0, CODE_LENGTH);
      const newCode = [...code];
      digits.forEach((d, i) => {
        if (index + i < CODE_LENGTH) {
          newCode[index + i] = d;
        }
      });
      setCode(newCode);
      const nextIndex = Math.min(index + digits.length, CODE_LENGTH - 1);
      inputRefs.current[nextIndex]?.focus();
      return;
    }

    const newCode = [...code];
    newCode[index] = value;
    setCode(newCode);

    if (value && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyPress = (e: any, index: number) => {
    if (e.nativeEvent.key === 'Backspace' && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
      const newCode = [...code];
      newCode[index - 1] = '';
      setCode(newCode);
    }
  };

  const handleReset = async () => {
    const codeString = code.join('');
    if (codeString.length !== CODE_LENGTH) {
      Alert.alert(t('common.error'), t('resetPassword.incompleteCode'));
      return;
    }
    if (!/^\d{4}$/.test(newPin)) {
      Alert.alert(t('common.error'), t('resetPassword.passwordMinLength'));
      return;
    }

    setIsLoading(true);
    const result = await resetPassword(identifier || '', codeString, newPin);
    setIsLoading(false);

    if (result.success) {
      Alert.alert(t('resetPassword.success'), t('resetPassword.successMessage'), [
        { text: t('common.signIn'), onPress: () => router.replace('/auth/signin') },
      ]);
    } else {
      Alert.alert(t('resetPassword.failed'), result.error || t('resetPassword.failedMessage'));
    }
  };

  const handleResend = async () => {
    setIsResending(true);
    const result = await requestPasswordReset(identifier || '');
    setIsResending(false);

    if (result.success) {
      Alert.alert(t('resetPassword.codeSent'), t('resetPassword.codeResentMessage'));
    } else {
      Alert.alert(t('common.error'), result.error || t('resetPassword.failedResend'));
    }
  };

  const displayIdentifier = identifier || (method === 'phone' ? t('resetPassword.yourPhone') : t('resetPassword.yourEmail'));

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
    content: {
      alignItems: 'center',
    },
    iconCircle: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: palette.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 40,
      marginBottom: 24,
      borderWidth: 1,
      borderColor: palette.border,
    },
    title: {
      fontSize: 24,
      fontWeight: '700',
      color: palette.text,
      marginBottom: 12,
    },
    subtitle: {
      fontSize: 15,
      color: palette.textSubtle,
      textAlign: 'center',
      lineHeight: 22,
      marginBottom: 8,
    },
    identifierText: {
      fontSize: 16,
      fontWeight: '600',
      color: palette.text,
      marginBottom: 32,
    },
    codeRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 10,
      marginBottom: 24,
    },
    codeInput: {
      width: 48,
      height: 56,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface,
      textAlign: 'center',
      fontSize: 22,
      fontWeight: '700',
      color: palette.text,
    },
    codeInputFilled: {
      borderColor: palette.text,
    },
    inputGroup: {
      width: '100%',
      marginBottom: 24,
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
    resetButton: {
      backgroundColor: palette.button,
      borderRadius: 12,
      paddingVertical: 16,
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      marginBottom: 20,
    },
    resetButtonDisabled: {
      backgroundColor: palette.disabled,
    },
    resetButtonText: {
      fontSize: 16,
      fontWeight: '700',
      color: palette.buttonText,
    },
    resendButton: {
      paddingVertical: 12,
    },
    resendText: {
      fontSize: 15,
      color: palette.textSubtle,
    },
    resendTextBold: {
      fontWeight: '600',
      color: palette.text,
    },
  }), [palette, insets]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={palette.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('resetPassword.title')}</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1 }}
        >
          <View style={styles.content}>
            <View style={styles.iconCircle}>
              <Ionicons name="shield-checkmark-outline" size={36} color={palette.text} />
            </View>

            <Text style={styles.title}>{t('resetPassword.heading')}</Text>
            <Text style={styles.subtitle}>{t('resetPassword.subtitle')}</Text>
            <Text style={styles.identifierText}>{displayIdentifier}</Text>

            {/* Code Inputs */}
            <View style={styles.codeRow}>
              {code.map((digit, index) => (
                <TextInput
                  key={index}
                  ref={(ref) => { inputRefs.current[index] = ref; }}
                  style={[styles.codeInput, digit && styles.codeInputFilled]}
                  value={digit}
                  onChangeText={(value) => handleCodeChange(value, index)}
                  onKeyPress={(e) => handleKeyPress(e, index)}
                  keyboardType="number-pad"
                  maxLength={1}
                  selectTextOnFocus
                />
              ))}
            </View>

            {/* New PIN */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>{t('resetPassword.newPassword')}</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="lock-closed-outline" size={20} color={palette.textSubtle} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder={t('resetPassword.passwordPlaceholder')}
                  placeholderTextColor={palette.textSubtle}
                  value={newPin}
                  onChangeText={setNewPin}
                  secureTextEntry
                  keyboardType="number-pad"
                  maxLength={4}
                />
              </View>
            </View>

            {/* Reset Button */}
            <TouchableOpacity
              style={[styles.resetButton, isLoading && styles.resetButtonDisabled]}
              onPress={handleReset}
              disabled={isLoading}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color={palette.buttonText} />
              ) : (
                <Text style={styles.resetButtonText}>{t('resetPassword.resetButton')}</Text>
              )}
            </TouchableOpacity>

            {/* Resend */}
            <TouchableOpacity style={styles.resendButton} onPress={handleResend} disabled={isResending}>
              <Text style={styles.resendText}>
                {t('resetPassword.didntReceive')}
                <Text style={styles.resendTextBold}>{isResending ? t('common.sending') : t('common.resend')}</Text>
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
