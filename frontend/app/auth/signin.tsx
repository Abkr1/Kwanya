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

export default function SigninScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signIn, signInWithGoogle } = useAuth();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
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
    google: '#4285F4',
  }), [isDark]);

  const handleSignin = async () => {
    if (!identifier.trim()) {
      Alert.alert('Error', 'Please enter your phone number or email');
      return;
    }
    if (!password.trim()) {
      Alert.alert('Error', 'Please enter your password');
      return;
    }

    setIsLoading(true);
    const result = await signIn(identifier.trim(), password);
    setIsLoading(false);

    if (result.success) {
      router.replace('/');
    } else {
      Alert.alert('Sign In Failed', result.error || 'Invalid credentials');
    }
  };

  const handleGoogleSignin = async () => {
    Alert.alert(
      'Google Sign-In',
      'Google sign-in requires additional configuration. Please set up a Google OAuth client ID in your environment.',
    );
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
      marginTop: 40,
      marginBottom: 40,
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
    divider: {
      flexDirection: 'row',
      alignItems: 'center',
      marginVertical: 24,
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
  }), [palette, insets]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={palette.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Sign In</Text>
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
              <Ionicons name="log-in-outline" size={36} color={palette.text} />
            </View>
            <Text style={styles.title}>Barka da dawowa</Text>
            <Text style={styles.subtitle}>Sign in to your Kwanya account</Text>
          </View>

          {/* Identifier input */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Phone Number or Email</Text>
            <View style={styles.inputWrapper}>
              <Ionicons name="person-outline" size={20} color={palette.textSubtle} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Phone or email"
                placeholderTextColor={palette.textSubtle}
                value={identifier}
                onChangeText={setIdentifier}
                autoCapitalize="none"
                autoComplete="username"
              />
            </View>
          </View>

          {/* Password */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Password</Text>
            <View style={styles.inputWrapper}>
              <Ionicons name="lock-closed-outline" size={20} color={palette.textSubtle} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Your password"
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

          {/* Sign In Button */}
          <TouchableOpacity
            style={[styles.signinButton, isLoading && styles.signinButtonDisabled]}
            onPress={handleSignin}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={palette.buttonText} />
            ) : (
              <Text style={styles.signinButtonText}>Sign In</Text>
            )}
          </TouchableOpacity>

          {/* Divider */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Google */}
          <TouchableOpacity style={styles.socialButton} onPress={handleGoogleSignin}>
            <View style={styles.googleIcon}>
              <Ionicons name="logo-google" size={12} color="#ffffff" />
            </View>
            <Text style={styles.socialButtonText}>Continue with Google</Text>
          </TouchableOpacity>

          {/* Sign up link */}
          <TouchableOpacity style={styles.signupLink} onPress={() => router.replace('/auth/signup')}>
            <Text style={styles.signupText}>Don't have an account? </Text>
            <Text style={styles.signupTextBold}>Sign Up</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
