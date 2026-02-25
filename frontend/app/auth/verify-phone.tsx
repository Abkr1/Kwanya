import React, { useState, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
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

const OTP_LENGTH = 4;

export default function VerifyPhoneScreen() {
  const { palette } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const { verifyOTP, resendOTP } = useAuth();

  const [otp, setOtp] = useState<string[]>(new Array(OTP_LENGTH).fill(''));
  const [isLoading, setIsLoading] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const inputRefs = useRef<(TextInput | null)[]>([]);

  const handleOtpChange = (value: string, index: number) => {
    if (value.length > 1) {
      // Handle paste
      const digits = value.replace(/\D/g, '').split('').slice(0, OTP_LENGTH);
      const newOtp = [...otp];
      digits.forEach((d, i) => {
        if (index + i < OTP_LENGTH) {
          newOtp[index + i] = d;
        }
      });
      setOtp(newOtp);
      const nextIndex = Math.min(index + digits.length, OTP_LENGTH - 1);
      inputRefs.current[nextIndex]?.focus();
      return;
    }

    const newOtp = [...otp];
    newOtp[index] = value;
    setOtp(newOtp);

    if (value && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyPress = (e: any, index: number) => {
    if (e.nativeEvent.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
      const newOtp = [...otp];
      newOtp[index - 1] = '';
      setOtp(newOtp);
    }
  };

  const handleVerify = async () => {
    const otpString = otp.join('');
    if (otpString.length !== OTP_LENGTH) {
      Alert.alert(t('common.error'), t('verifyPhone.incompleteCode'));
      return;
    }

    setIsLoading(true);
    const result = await verifyOTP(phone || '', otpString);
    setIsLoading(false);

    if (result.success) {
      Alert.alert(t('verifyPhone.verified'), t('verifyPhone.verifiedMessage'), [
        { text: t('common.continue'), onPress: () => router.replace('/') },
      ]);
    } else {
      Alert.alert(t('verifyPhone.verificationFailed'), result.error || t('verifyPhone.invalidCode'));
    }
  };

  const handleResend = async () => {
    setIsResending(true);
    const result = await resendOTP(phone || '');
    setIsResending(false);

    if (result.success) {
      Alert.alert(t('verifyPhone.sent'), t('verifyPhone.resentMessage'));
    } else {
      Alert.alert(t('common.error'), result.error || t('verifyPhone.failedResend'));
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
    content: {
      flex: 1,
      paddingHorizontal: 24,
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
    phoneText: {
      fontSize: 16,
      fontWeight: '600',
      color: palette.text,
      marginBottom: 32,
    },
    otpRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 10,
      marginBottom: 32,
    },
    otpInput: {
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
    otpInputFilled: {
      borderColor: palette.text,
    },
    verifyButton: {
      backgroundColor: palette.button,
      borderRadius: 12,
      paddingVertical: 16,
      paddingHorizontal: 48,
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      marginBottom: 20,
    },
    verifyButtonDisabled: {
      backgroundColor: palette.disabled,
    },
    verifyButtonText: {
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
        <Text style={styles.headerTitle}>{t('verifyPhone.title')}</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.content}>
          <View style={styles.iconCircle}>
            <Ionicons name="shield-checkmark-outline" size={36} color={palette.text} />
          </View>

          <Text style={styles.title}>{t('verifyPhone.enterCode')}</Text>
          <Text style={styles.subtitle}>
            {t('verifyPhone.subtitle')}
          </Text>
          <Text style={styles.phoneText}>{phone || t('verifyPhone.fallback')}</Text>

          {/* OTP Inputs */}
          <View style={styles.otpRow}>
            {otp.map((digit, index) => (
              <TextInput
                key={index}
                ref={(ref) => { inputRefs.current[index] = ref; }}
                style={[styles.otpInput, digit && styles.otpInputFilled]}
                value={digit}
                onChangeText={(value) => handleOtpChange(value, index)}
                onKeyPress={(e) => handleKeyPress(e, index)}
                keyboardType="number-pad"
                maxLength={1}
                selectTextOnFocus
              />
            ))}
          </View>

          {/* Verify Button */}
          <TouchableOpacity
            style={[styles.verifyButton, isLoading && styles.verifyButtonDisabled]}
            onPress={handleVerify}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={palette.buttonText} />
            ) : (
              <Text style={styles.verifyButtonText}>{t('common.verify')}</Text>
            )}
          </TouchableOpacity>

          {/* Resend */}
          <TouchableOpacity style={styles.resendButton} onPress={handleResend} disabled={isResending}>
            <Text style={styles.resendText}>
              {t('verifyPhone.didntReceive')}
              <Text style={styles.resendTextBold}>{isResending ? t('common.sending') : t('common.resend')}</Text>
            </Text>
          </TouchableOpacity>

        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
