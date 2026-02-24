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

const CODE_LENGTH = 6;

export default function VerifyEmailScreen() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { email } = useLocalSearchParams<{ email: string }>();
  const { verifyEmail, resendEmailCode } = useAuth();

  const [code, setCode] = useState<string[]>(new Array(CODE_LENGTH).fill(''));
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

  const handleVerify = async () => {
    const codeString = code.join('');
    if (codeString.length !== CODE_LENGTH) {
      Alert.alert('Error', 'Please enter the complete verification code');
      return;
    }

    setIsLoading(true);
    const result = await verifyEmail(email || '', codeString);
    setIsLoading(false);

    if (result.success) {
      Alert.alert('Verified', 'Email verified successfully!', [
        { text: 'Continue', onPress: () => router.replace('/') },
      ]);
    } else {
      Alert.alert('Verification Failed', result.error || 'Invalid code');
    }
  };

  const handleResend = async () => {
    setIsResending(true);
    const result = await resendEmailCode(email || '');
    setIsResending(false);

    if (result.success) {
      Alert.alert('Sent', 'A new verification code has been sent to your email');
    } else {
      Alert.alert('Error', result.error || 'Failed to resend code');
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
    emailText: {
      fontSize: 16,
      fontWeight: '600',
      color: palette.text,
      marginBottom: 32,
    },
    codeRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 10,
      marginBottom: 32,
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
        <Text style={styles.headerTitle}>Verify Email</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.content}>
          <View style={styles.iconCircle}>
            <Ionicons name="mail-open-outline" size={36} color={palette.text} />
          </View>

          <Text style={styles.title}>Check Your Email</Text>
          <Text style={styles.subtitle}>
            We sent a verification code to
          </Text>
          <Text style={styles.emailText}>{email || 'your email'}</Text>

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

          {/* Verify Button */}
          <TouchableOpacity
            style={[styles.verifyButton, isLoading && styles.verifyButtonDisabled]}
            onPress={handleVerify}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={palette.buttonText} />
            ) : (
              <Text style={styles.verifyButtonText}>Verify</Text>
            )}
          </TouchableOpacity>

          {/* Resend */}
          <TouchableOpacity style={styles.resendButton} onPress={handleResend} disabled={isResending}>
            <Text style={styles.resendText}>
              Didn't receive the code?{' '}
              <Text style={styles.resendTextBold}>{isResending ? 'Sending...' : 'Resend'}</Text>
            </Text>
          </TouchableOpacity>

        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
