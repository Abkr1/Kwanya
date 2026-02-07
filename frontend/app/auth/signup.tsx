import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Alert,
  useColorScheme,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '../../contexts/AuthContext';

type SignupMode = 'phone' | 'email';

export default function SignupScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signUpWithPhone, signUpWithEmail, signUpWithGoogle } = useAuth();

  const [mode, setMode] = useState<SignupMode>('phone');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const palette = useMemo(() => ({
    bg: isDark ? '#000000' : '#ffffff',
    surface: isDark ? '#0d0d0d' : '#f7f7f7',
    surfaceAlt: isDark ? '#151515' : '#f2f2f2',
    text: isDark ? '#ffffff' : '#000000',
    textMuted: isDark ? '#c7c7c7' : '#333333',
    textSubtle: isDark ? '#9a9a9a' : '#666666',
    border: isDark ? '#2a2a2a' : '#e5e5e5',
    button: isDark ? '#ffffff' : '#000000',
    buttonText: isDark ? '#000000' : '#ffffff',
    disabled: isDark ? '#2f2f2f' : '#d9d9d9',
    error: '#e53935',
    google: '#4285F4',
  }), [isDark]);

  const handlePhoneSignup = async () => {
    if (!phone.trim()) {
      Alert.alert('Error', 'Please enter your phone number');
      return;
    }
    if (!password.trim() || password.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters');
      return;
    }

    setIsLoading(true);
    const result = await signUpWithPhone(phone.trim(), password, displayName.trim() || undefined);
    setIsLoading(false);

    if (result.success) {
      Alert.alert(
        'Account Created',
        `Your auto-generated email: ${result.generatedEmail}\n\nYou can use this email or your phone number to sign in.`,
        [
          {
            text: 'Verify Phone',
            onPress: () => router.replace({ pathname: '/auth/verify-phone', params: { phone: phone.trim() } }),
          },
          {
            text: 'Continue',
            onPress: () => router.replace('/'),
          },
        ]
      );
    } else {
      Alert.alert('Sign Up Failed', result.error || 'Please try again');
    }
  };

  const handleEmailSignup = async () => {
    if (!email.trim()) {
      Alert.alert('Error', 'Please enter your email address');
      return;
    }
    if (!password.trim() || password.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters');
      return;
    }

    setIsLoading(true);
    const result = await signUpWithEmail(email.trim(), password, displayName.trim() || undefined);
    setIsLoading(false);

    if (result.success) {
      router.replace('/');
    } else {
      Alert.alert('Sign Up Failed', result.error || 'Please try again');
    }
  };

  const handleGoogleSignup = async () => {
    // Google sign-in requires expo-auth-session or @react-native-google-signin
    // For now, show configuration message
    Alert.alert(
      'Google Sign-Up',
      'Google sign-in requires additional configuration. Please set up a Google OAuth client ID in your environment.',
    );
  };

  const handleSignup = () => {
    if (mode === 'phone') {
      handlePhoneSignup();
    } else {
      handleEmailSignup();
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
      marginTop: 24,
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
    passwordToggle: {
      padding: 4,
    },
    signupButton: {
      backgroundColor: palette.button,
      borderRadius: 12,
      paddingVertical: 16,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 8,
      marginBottom: 16,
    },
    signupButtonDisabled: {
      backgroundColor: palette.disabled,
    },
    signupButtonText: {
      fontSize: 16,
      fontWeight: '700',
      color: palette.buttonText,
    },
    divider: {
      flexDirection: 'row',
      alignItems: 'center',
      marginVertical: 20,
    },
    dividerLine: {
      flex: 1,
      height: 1,
      backgroundColor: palette.border,
    },
    dividerText: {
      marginHorizontal: 16,
      fontSize: 14,
      color: palette.textSubtle,
    },
    socialButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 14,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.bg,
      marginBottom: 12,
    },
    socialButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: palette.text,
      marginLeft: 10,
    },
    googleIcon: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: palette.google,
      alignItems: 'center',
      justifyContent: 'center',
    },
    signinLink: {
      flexDirection: 'row',
      justifyContent: 'center',
      paddingVertical: 20,
    },
    signinText: {
      fontSize: 15,
      color: palette.textSubtle,
    },
    signinTextBold: {
      fontSize: 15,
      fontWeight: '700',
      color: palette.text,
    },
    autoEmailNote: {
      backgroundColor: palette.surfaceAlt,
      borderRadius: 10,
      padding: 12,
      marginBottom: 16,
      flexDirection: 'row',
      alignItems: 'flex-start',
    },
    autoEmailText: {
      flex: 1,
      fontSize: 13,
      color: palette.textSubtle,
      marginLeft: 8,
      lineHeight: 18,
    },
  }), [palette, insets]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={palette.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Sign Up</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.titleSection}>
            <View style={styles.iconCircle}>
              <Ionicons name="person-add-outline" size={36} color={palette.text} />
            </View>
            <Text style={styles.title}>Yi Rajista</Text>
            <Text style={styles.subtitle}>Create your Kwanya account</Text>
          </View>

          {/* Mode Toggle */}
          <View style={styles.modeToggle}>
            <TouchableOpacity
              style={[styles.modeButton, mode === 'phone' && styles.modeButtonActive]}
              onPress={() => setMode('phone')}
            >
              <Text style={[styles.modeButtonText, mode === 'phone' && styles.modeButtonTextActive]}>
                Phone Number
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeButton, mode === 'email' && styles.modeButtonActive]}
              onPress={() => setMode('email')}
            >
              <Text style={[styles.modeButtonText, mode === 'email' && styles.modeButtonTextActive]}>
                Email
              </Text>
            </TouchableOpacity>
          </View>

          {/* Auto-email note for phone signup */}
          {mode === 'phone' && (
            <View style={styles.autoEmailNote}>
              <Ionicons name="information-circle-outline" size={18} color={palette.textSubtle} />
              <Text style={styles.autoEmailText}>
                An email address will be automatically created for you when you sign up with your phone number.
              </Text>
            </View>
          )}

          {/* Display Name */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Display Name (optional)</Text>
            <View style={styles.inputWrapper}>
              <Ionicons name="person-outline" size={20} color={palette.textSubtle} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Your name"
                placeholderTextColor={palette.textSubtle}
                value={displayName}
                onChangeText={setDisplayName}
                autoCapitalize="words"
              />
            </View>
          </View>

          {/* Phone or Email input */}
          {mode === 'phone' ? (
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Phone Number</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="call-outline" size={20} color={palette.textSubtle} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="+234 801 234 5678"
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
              <Text style={styles.inputLabel}>Email Address</Text>
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

          {/* Password */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Password</Text>
            <View style={styles.inputWrapper}>
              <Ionicons name="lock-closed-outline" size={20} color={palette.textSubtle} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="At least 6 characters"
                placeholderTextColor={palette.textSubtle}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
              />
              <TouchableOpacity style={styles.passwordToggle} onPress={() => setShowPassword(!showPassword)}>
                <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={20} color={palette.textSubtle} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Sign Up Button */}
          <TouchableOpacity
            style={[styles.signupButton, isLoading && styles.signupButtonDisabled]}
            onPress={handleSignup}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={palette.buttonText} />
            ) : (
              <Text style={styles.signupButtonText}>
                {mode === 'phone' ? 'Sign Up with Phone' : 'Sign Up with Email'}
              </Text>
            )}
          </TouchableOpacity>

          {/* Divider */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Alternative: Switch to other mode */}
          {mode === 'phone' ? (
            <TouchableOpacity style={styles.socialButton} onPress={() => setMode('email')}>
              <Ionicons name="mail-outline" size={20} color={palette.text} />
              <Text style={styles.socialButtonText}>Continue with Email</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.socialButton} onPress={() => setMode('phone')}>
              <Ionicons name="call-outline" size={20} color={palette.text} />
              <Text style={styles.socialButtonText}>Continue with Phone</Text>
            </TouchableOpacity>
          )}

          {/* Google */}
          <TouchableOpacity style={styles.socialButton} onPress={handleGoogleSignup}>
            <View style={styles.googleIcon}>
              <Ionicons name="logo-google" size={12} color="#ffffff" />
            </View>
            <Text style={styles.socialButtonText}>Continue with Google</Text>
          </TouchableOpacity>

          {/* Sign in link */}
          <TouchableOpacity style={styles.signinLink} onPress={() => router.replace('/auth/signin')}>
            <Text style={styles.signinText}>Already have an account? </Text>
            <Text style={styles.signinTextBold}>Sign In</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
