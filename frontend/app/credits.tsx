import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import axios from 'axios';
import { useAuth } from './_contexts/AuthContext';
import { useTheme } from './_contexts/ThemeContext';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8001';

const CREDIT_PACKS = [
  { credits: 100, price: 100, label: '100 Credits', priceLabel: '\u20A6100' },
  { credits: 200, price: 200, label: '200 Credits', priceLabel: '\u20A6200' },
  { credits: 500, price: 500, label: '500 Credits', priceLabel: '\u20A6500' },
];

const CREDIT_RATE = 1; // N1 per credit
const MIN_AMOUNT = 100;

export default function CreditsScreen() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, isAuthenticated, token } = useAuth();

  const [balance, setBalance] = useState(user?.credit_balance ?? 0);
  const [customAmount, setCustomAmount] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [currentPaymentRef, setCurrentPaymentRef] = useState<string | null>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pollCountRef = useRef(0);

  const authHeaders = useMemo(
    () => (token ? { Authorization: `Bearer ${token}` } : {}),
    [token],
  );

  const customCredits = useMemo(() => {
    const amt = parseFloat(customAmount);
    if (!amt || amt < MIN_AMOUNT) return 0;
    return Math.floor(amt / CREDIT_RATE);
  }, [customAmount]);

  const fetchBalance = useCallback(async () => {
    if (!token) return;
    try {
      const resp = await axios.get(`${BACKEND_URL}/api/credits/balance`, {
        headers: authHeaders,
      });
      if (resp.data.success) setBalance(resp.data.credit_balance);
    } catch {
      // silent
    }
  }, [token, authHeaders]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const startPolling = useCallback(
    (paymentRef: string) => {
      pollCountRef.current = 0;
      pollTimerRef.current = setInterval(async () => {
        pollCountRef.current += 1;
        if (pollCountRef.current > 40) {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setCheckoutUrl(null);
          setCurrentPaymentRef(null);
          Alert.alert(
            'Payment Pending',
            'We could not confirm your payment yet. If you completed the payment, your credits will be added shortly.',
          );
          return;
        }
        try {
          const resp = await axios.get(
            `${BACKEND_URL}/api/credits/verify/${paymentRef}`,
            { headers: authHeaders },
          );
          if (resp.data.status === 'completed') {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setCheckoutUrl(null);
            setCurrentPaymentRef(null);
            await fetchBalance();
            Alert.alert('Success', `${resp.data.credits} credits added to your balance!`);
          }
        } catch {
          // keep polling
        }
      }, 3000);
    },
    [authHeaders, fetchBalance],
  );

  const handleBuy = async (amount: number, credits: number) => {
    if (!isAuthenticated || !token) {
      Alert.alert('Sign In Required', 'Please sign in to purchase credits.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign In', onPress: () => router.push('/auth/signin') },
      ]);
      return;
    }

    setIsLoading(true);
    try {
      const resp = await axios.post(
        `${BACKEND_URL}/api/credits/initialize`,
        { amount, credits },
        { headers: authHeaders },
      );
      if (resp.data.success) {
        setCheckoutUrl(resp.data.checkout_url);
        setCurrentPaymentRef(resp.data.payment_reference);
        startPolling(resp.data.payment_reference);
      }
    } catch (error: any) {
      const msg = error.response?.data?.detail || 'Failed to initialize payment';
      Alert.alert('Error', msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleWebViewNavigationChange = (navState: { url: string }) => {
    if (navState.url.includes('kwanya.app/payment/complete') || navState.url.includes('payment/complete')) {
      // Payment flow completed — polling will handle the rest
      setCheckoutUrl(null);
    }
  };

  const handleCloseCheckout = () => {
    setCheckoutUrl(null);
    // Polling continues in background
  };

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
        balanceCard: {
          margin: 20,
          padding: 24,
          backgroundColor: palette.surface,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: palette.border,
          alignItems: 'center',
        },
        balanceLabel: {
          fontSize: 14,
          color: palette.textSubtle,
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        },
        balanceValue: {
          fontSize: 40,
          fontWeight: '800',
          color: palette.text,
        },
        balanceUnit: {
          fontSize: 14,
          color: palette.textMuted,
          marginTop: 4,
        },
        section: { paddingHorizontal: 20, marginBottom: 24 },
        sectionTitle: {
          fontSize: 13,
          fontWeight: '600',
          color: palette.textSubtle,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          marginBottom: 12,
          paddingHorizontal: 4,
        },
        packCard: {
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
        packInfo: { flex: 1 },
        packCredits: {
          fontSize: 17,
          fontWeight: '700',
          color: palette.text,
        },
        packPrice: {
          fontSize: 14,
          color: palette.textMuted,
          marginTop: 2,
        },
        buyButton: {
          backgroundColor: palette.button,
          borderRadius: 10,
          paddingHorizontal: 20,
          paddingVertical: 10,
        },
        buyButtonText: {
          fontSize: 14,
          fontWeight: '700',
          color: palette.buttonText,
        },
        customCard: {
          backgroundColor: palette.surface,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: palette.border,
          padding: 16,
        },
        customLabel: {
          fontSize: 14,
          fontWeight: '600',
          color: palette.textMuted,
          marginBottom: 8,
        },
        customInput: {
          backgroundColor: palette.bg,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: palette.border,
          paddingHorizontal: 14,
          paddingVertical: 10,
          fontSize: 16,
          color: palette.text,
          marginBottom: 8,
        },
        customCreditsText: {
          fontSize: 13,
          color: palette.textSubtle,
          marginBottom: 12,
        },
        customBuyButton: {
          backgroundColor: palette.button,
          borderRadius: 10,
          paddingVertical: 14,
          alignItems: 'center',
        },
        customBuyButtonDisabled: {
          backgroundColor: palette.disabled,
        },
        customBuyButtonText: {
          fontSize: 16,
          fontWeight: '700',
          color: palette.buttonText,
        },
        webviewContainer: {
          ...StyleSheet.absoluteFillObject,
          backgroundColor: palette.bg,
          zIndex: 200,
          paddingTop: insets.top,
        },
        webviewHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: palette.border,
          backgroundColor: palette.bg,
        },
        webviewTitle: {
          fontSize: 16,
          fontWeight: '600',
          color: palette.text,
          marginLeft: 12,
        },
        centeredContent: {
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: 32,
        },
        iconCircle: {
          width: 96,
          height: 96,
          borderRadius: 48,
          backgroundColor: palette.surfaceAlt,
          borderColor: palette.border,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 20,
          borderWidth: 1,
        },
        noAuthTitle: {
          fontSize: 24,
          fontWeight: '700',
          color: palette.text,
          marginBottom: 8,
        },
        noAuthSubtitle: {
          fontSize: 15,
          color: palette.textSubtle,
          textAlign: 'center',
          lineHeight: 22,
          marginBottom: 32,
        },
        primaryButton: {
          width: '100%',
          backgroundColor: palette.button,
          borderRadius: 12,
          paddingVertical: 16,
          alignItems: 'center',
          marginBottom: 12,
        },
        primaryButtonText: {
          fontSize: 16,
          fontWeight: '700',
          color: palette.buttonText,
        },
        secondaryButton: {
          width: '100%',
          borderRadius: 12,
          paddingVertical: 16,
          alignItems: 'center',
          borderWidth: 1,
          borderColor: palette.border,
        },
        secondaryButtonText: {
          fontSize: 16,
          fontWeight: '600',
          color: palette.text,
        },
      }),
    [palette, insets],
  );

  // Not authenticated - show sign-in prompt
  if (!isAuthenticated || !user) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => router.replace({ pathname: '/', params: { sidebar: '1' } })}
          >
            <Ionicons name="arrow-back" size={24} color={palette.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Credits</Text>
        </View>
        <View style={styles.centeredContent}>
          <View style={styles.iconCircle}>
            <Ionicons name="wallet-outline" size={48} color={palette.textSubtle} />
          </View>
          <Text style={styles.noAuthTitle}>Sign In Required</Text>
          <Text style={styles.noAuthSubtitle}>
            Sign in or create an account to purchase and manage credits
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={() => router.push('/auth/signup')}>
            <Text style={styles.primaryButtonText}>Sign Up</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => router.push('/auth/signin')}>
            <Text style={styles.secondaryButtonText}>Sign In</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // WebView checkout overlay
  if (checkoutUrl) {
    return (
      <View style={styles.webviewContainer}>
        <View style={styles.webviewHeader}>
          <TouchableOpacity style={styles.backButton} onPress={handleCloseCheckout}>
            <Ionicons name="close" size={24} color={palette.text} />
          </TouchableOpacity>
          <Text style={styles.webviewTitle}>Complete Payment</Text>
        </View>
        <WebView
          source={{ uri: checkoutUrl }}
          style={{ flex: 1 }}
          onNavigationStateChange={handleWebViewNavigationChange}
          javaScriptEnabled
          domStorageEnabled
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.replace({ pathname: '/', params: { sidebar: '1' } })}
        >
          <Ionicons name="arrow-back" size={24} color={palette.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Credits</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top}
      >
        <ScrollView
          style={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Balance Card */}
          <View style={styles.balanceCard}>
            <Text style={styles.balanceLabel}>Your Balance</Text>
            <Text style={styles.balanceValue}>{balance.toLocaleString()}</Text>
            <Text style={styles.balanceUnit}>credits</Text>
          </View>

          {/* Preset Packs */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Buy Credits</Text>
            {CREDIT_PACKS.map((pack) => (
              <View key={pack.credits} style={styles.packCard}>
                <View style={styles.packInfo}>
                  <Text style={styles.packCredits}>{pack.label}</Text>
                  <Text style={styles.packPrice}>{pack.priceLabel}</Text>
                </View>
                <TouchableOpacity
                  style={styles.buyButton}
                  onPress={() => handleBuy(pack.price, pack.credits)}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <ActivityIndicator size="small" color={palette.buttonText} />
                  ) : (
                    <Text style={styles.buyButtonText}>Buy</Text>
                  )}
                </TouchableOpacity>
              </View>
            ))}
          </View>

          {/* Custom Amount */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Custom Amount</Text>
            <View style={styles.customCard}>
              <Text style={styles.customLabel}>Amount (NGN)</Text>
              <TextInput
                style={styles.customInput}
                value={customAmount}
                onChangeText={setCustomAmount}
                placeholder={`Min \u20A6${MIN_AMOUNT}`}
                placeholderTextColor={palette.textSubtle}
                keyboardType="numeric"
              />
              {customCredits > 0 && (
                <Text style={styles.customCreditsText}>
                  You'll get {customCredits.toLocaleString()} credits
                </Text>
              )}
              <TouchableOpacity
                style={[
                  styles.customBuyButton,
                  customCredits === 0 && styles.customBuyButtonDisabled,
                ]}
                onPress={() => {
                  const amt = parseFloat(customAmount);
                  if (amt >= MIN_AMOUNT && customCredits > 0) {
                    handleBuy(amt, customCredits);
                  }
                }}
                disabled={customCredits === 0 || isLoading}
              >
                {isLoading ? (
                  <ActivityIndicator size="small" color={palette.buttonText} />
                ) : (
                  <Text style={styles.customBuyButtonText}>
                    {customCredits > 0
                      ? `Buy ${customCredits.toLocaleString()} Credits`
                      : 'Enter Amount'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
