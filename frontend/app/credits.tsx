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
  BackHandler,
  Linking,
} from 'react-native';
let WebView: any = null;
if (Platform.OS !== 'web') {
  WebView = require('react-native-webview').WebView;
}
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './_contexts/AuthContext';
import { useTheme } from './_contexts/ThemeContext';
import { useLanguage } from './_contexts/LanguageContext';

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
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, isAuthenticated, token } = useAuth();

  const [balance, setBalance] = useState(user?.credit_balance ?? 0);
  const [showBalance, setShowBalance] = useState(false);
  const [activeTab, setActiveTab] = useState<'buy' | 'send'>('buy');
  const [customAmount, setCustomAmount] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [transferRecipient, setTransferRecipient] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [isSending, setIsSending] = useState(false);
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

  const CREDITS_BALANCE_CACHE_KEY = 'kwanya_credits_balance';

  const fetchBalance = useCallback(async () => {
    if (!token) return;

    // 1. Show cached balance instantly
    try {
      const cached = await AsyncStorage.getItem(CREDITS_BALANCE_CACHE_KEY);
      if (cached) setBalance(Number(cached));
    } catch {}

    // 2. Fetch fresh balance from server
    try {
      const resp = await axios.get(`${BACKEND_URL}/api/credits/balance`, {
        headers: authHeaders,
        timeout: 10000,
      });
      if (resp.data.success) {
        setBalance(resp.data.credit_balance);
        await AsyncStorage.setItem(CREDITS_BALANCE_CACHE_KEY, String(resp.data.credit_balance));
      }
    } catch {
      // silent — cached balance already shown
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

  useEffect(() => {
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (checkoutUrl) {
        setCheckoutUrl(null);
      } else {
        router.replace({ pathname: '/', params: { sidebar: '1' } });
      }
      return true;
    });
    return () => handler.remove();
  }, [checkoutUrl, router]);

  const startPolling = useCallback(
    (paymentRef: string) => {
      pollCountRef.current = 0;
      pollTimerRef.current = setInterval(async () => {
        pollCountRef.current += 1;
        if (pollCountRef.current > 100) {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setCheckoutUrl(null);
          setCurrentPaymentRef(null);
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
            Alert.alert(t('common.success'), t('credits.creditsAdded').replace('{count}', resp.data.credits.toString()));
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
      Alert.alert(t('credits.signInRequired'), t('credits.signInToPurchase'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.signIn'), onPress: () => router.push('/auth/signin') },
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
        setCurrentPaymentRef(resp.data.payment_reference);
        startPolling(resp.data.payment_reference);
        if (Platform.OS === 'web') {
          // Open payment in new browser tab
          window.open(resp.data.checkout_url, '_blank');
        } else {
          setCheckoutUrl(resp.data.checkout_url);
        }
      }
    } catch (error: any) {
      const msg = error.response?.data?.detail || t('credits.failedInitPayment');
      Alert.alert(t('common.error'), msg);
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

  const handleCancelPayment = () => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    setCheckoutUrl(null);
    setCurrentPaymentRef(null);
  };

  const transferCredits = useMemo(() => {
    const amt = parseInt(transferAmount, 10);
    if (!amt || amt < 50) return 0;
    return amt;
  }, [transferAmount]);

  const handleTransfer = async () => {
    if (!isAuthenticated || !token) {
      Alert.alert(t('credits.signInRequired'), t('credits.signInToPurchase'));
      return;
    }
    const amt = parseInt(transferAmount, 10);
    if (!amt || amt < 50) {
      Alert.alert(t('common.error'), t('credits.minTransfer'));
      return;
    }
    if (!transferRecipient.trim()) {
      Alert.alert(t('common.error'), t('credits.recipient'));
      return;
    }

    setIsSending(true);
    try {
      const resp = await axios.post(
        `${BACKEND_URL}/api/credits/transfer`,
        { recipient: transferRecipient.trim(), amount: amt },
        { headers: authHeaders },
      );
      if (resp.data.success) {
        Alert.alert(
          t('common.success'),
          t('credits.transferSuccess')
            .replace('{count}', amt.toString())
            .replace('{name}', resp.data.recipient_name),
        );
        setTransferRecipient('');
        setTransferAmount('');
        await fetchBalance();
      }
    } catch (error: any) {
      const detail = error.response?.data?.detail || t('common.error');
      Alert.alert(t('common.error'), detail);
    } finally {
      setIsSending(false);
    }
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
          marginHorizontal: 20,
          marginTop: 20,
          marginBottom: 12,
          padding: 16,
          backgroundColor: palette.surface,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: palette.border,
        },
        balanceLabel: {
          fontSize: 13,
          color: palette.textSubtle,
          marginBottom: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontWeight: '600',
        },
        balanceValue: {
          fontSize: 36,
          fontWeight: '800',
          color: palette.text,
          marginBottom: 4,
        },
        barTrack: {
          height: 8,
          borderRadius: 4,
          backgroundColor: palette.border,
          overflow: 'hidden',
        },
        barFill: {
          height: '100%',
          borderRadius: 4,
          backgroundColor: palette.button,
        },
        balanceHint: {
          fontSize: 12,
          color: palette.textMuted,
          marginTop: 8,
        },
        tabRow: {
          flexDirection: 'row',
          marginHorizontal: 20,
          marginBottom: 16,
          borderRadius: 10,
          backgroundColor: palette.surface,
          borderWidth: 1,
          borderColor: palette.border,
          overflow: 'hidden',
        },
        tab: {
          flex: 1,
          paddingVertical: 12,
          alignItems: 'center',
        },
        tabActive: {
          backgroundColor: palette.button,
        },
        tabText: {
          fontSize: 14,
          fontWeight: '600',
          color: palette.textMuted,
        },
        tabTextActive: {
          color: palette.buttonText,
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
          paddingBottom: insets.bottom,
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
          <Text style={styles.headerTitle}>{t('credits.title')}</Text>
        </View>
        <View style={styles.centeredContent}>
          <View style={styles.iconCircle}>
            <Ionicons name="wallet-outline" size={48} color={palette.textSubtle} />
          </View>
          <Text style={styles.noAuthTitle}>{t('credits.signInRequired')}</Text>
          <Text style={styles.noAuthSubtitle}>
            {t('credits.signInOrCreate')}
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={() => router.push('/auth/signup')}>
            <Text style={styles.primaryButtonText}>{t('common.signUp')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => router.push('/auth/signin')}>
            <Text style={styles.secondaryButtonText}>{t('common.signIn')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Web: show waiting screen while payment tab is open
  if (Platform.OS === 'web' && currentPaymentRef && !checkoutUrl) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={handleCancelPayment}>
            <Ionicons name="arrow-back" size={24} color={palette.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('credits.title')}</Text>
        </View>
        <View style={styles.centeredContent}>
          <ActivityIndicator size="large" color={palette.button} style={{ marginBottom: 20 }} />
          <Text style={styles.noAuthTitle}>{t('credits.completingPayment')}</Text>
          <Text style={styles.noAuthSubtitle}>
            {t('credits.completeInTab')}
          </Text>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={handleCancelPayment}
          >
            <Text style={styles.secondaryButtonText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Native: WebView checkout overlay
  if (checkoutUrl && WebView) {
    return (
      <View style={styles.webviewContainer}>
        <View style={styles.webviewHeader}>
          <TouchableOpacity style={styles.backButton} onPress={handleCloseCheckout}>
            <Ionicons name="close" size={24} color={palette.text} />
          </TouchableOpacity>
          <Text style={styles.webviewTitle}>{t('credits.completePayment')}</Text>
        </View>
        <WebView
          source={{ uri: checkoutUrl }}
          style={{ flex: 1 }}
          onNavigationStateChange={handleWebViewNavigationChange}
          javaScriptEnabled
          domStorageEnabled
          thirdPartyCookiesEnabled
          mixedContentMode="compatibility"
          originWhitelist={['https://*', 'http://*']}
          cacheEnabled
          startInLoadingState
          renderLoading={() => (
            <ActivityIndicator
              size="large"
              color={palette.button}
              style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}
            />
          )}
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
        <Text style={styles.headerTitle}>{t('credits.title')}</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={insets.top}
      >
        <ScrollView
          style={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Balance Card */}
          <TouchableOpacity
            style={styles.balanceCard}
            onPress={() => setShowBalance(!showBalance)}
            activeOpacity={0.7}
          >
            {showBalance ? (
              <>
                <Text style={styles.balanceLabel}>{t('credits.yourBalance')}</Text>
                <Text style={styles.balanceValue}>{balance.toLocaleString()}</Text>
                <Text style={styles.balanceHint}>{t('credits.credits')}</Text>
              </>
            ) : (
              <>
                <Text style={styles.balanceLabel}>{t('credits.balance')}</Text>
                <View style={styles.barTrack}>
                  <View
                    style={[
                      styles.barFill,
                      { width: `${Math.min(100, Math.max(2, (balance / Math.max(balance, 500)) * 100))}%` },
                    ]}
                  />
                </View>
                <Text style={styles.balanceHint}>
                  {balance === 0 ? t('credits.noCreditsRemaining') : balance < 30 ? t('credits.runningLow') : t('credits.tapToView')}
                </Text>
              </>
            )}
          </TouchableOpacity>

          {/* Tab Switcher */}
          <View style={styles.tabRow}>
            <TouchableOpacity
              style={[styles.tab, activeTab === 'buy' && styles.tabActive]}
              onPress={() => setActiveTab('buy')}
            >
              <Text style={[styles.tabText, activeTab === 'buy' && styles.tabTextActive]}>
                {t('credits.buyCredits')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, activeTab === 'send' && styles.tabActive]}
              onPress={() => setActiveTab('send')}
            >
              <Text style={[styles.tabText, activeTab === 'send' && styles.tabTextActive]}>
                {t('credits.sendCredits')}
              </Text>
            </TouchableOpacity>
          </View>

          {activeTab === 'buy' ? (
            <>
              {/* Preset Packs */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('credits.buyCredits')}</Text>
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
                        <Text style={styles.buyButtonText}>{t('common.buy')}</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                ))}
              </View>

              {/* Custom Amount */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('credits.customAmount')}</Text>
                <View style={styles.customCard}>
                  <Text style={styles.customLabel}>{t('credits.amountNGN')}</Text>
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
                      {t('credits.youllGet').replace('{count}', customCredits.toLocaleString())}
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
                          ? t('credits.buyCount').replace('{count}', customCredits.toLocaleString())
                          : t('credits.enterAmount')}
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </>
          ) : (
            <>
              {/* Send Credits */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('credits.sendCredits')}</Text>
                <View style={styles.customCard}>
                  <Text style={styles.customLabel}>{t('credits.recipient')}</Text>
                  <TextInput
                    style={styles.customInput}
                    value={transferRecipient}
                    onChangeText={setTransferRecipient}
                    placeholder={t('credits.recipient')}
                    placeholderTextColor={palette.textSubtle}
                    keyboardType="default"
                    autoCapitalize="none"
                  />
                  <Text style={styles.customLabel}>{t('credits.sendAmount')}</Text>
                  <TextInput
                    style={styles.customInput}
                    value={transferAmount}
                    onChangeText={setTransferAmount}
                    placeholder="Min 50"
                    placeholderTextColor={palette.textSubtle}
                    keyboardType="numeric"
                  />
                  <TouchableOpacity
                    style={[
                      styles.customBuyButton,
                      transferCredits === 0 && styles.customBuyButtonDisabled,
                    ]}
                    onPress={handleTransfer}
                    disabled={transferCredits === 0 || isSending}
                  >
                    {isSending ? (
                      <ActivityIndicator size="small" color={palette.buttonText} />
                    ) : (
                      <Text style={styles.customBuyButtonText}>
                        {transferCredits > 0
                          ? t('credits.send').replace('{count}', transferCredits.toLocaleString())
                          : t('credits.sendCredits')}
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
