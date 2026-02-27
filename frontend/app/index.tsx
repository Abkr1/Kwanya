import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  Keyboard,
  ScrollView,
  Animated,
  useWindowDimensions,
  Easing,
  BackHandler,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Audio } from 'expo-av';
import axios, { AxiosError } from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from './_contexts/AuthContext';
import { useTheme } from './_contexts/ThemeContext';
import { useLanguage } from './_contexts/LanguageContext';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8001';
const USER_ID_STORAGE_KEY = 'kwanya_user_id';
const CONVERSATIONS_CACHE_KEY = 'kwanya_conversations_cache';
const CREDITS_BALANCE_CACHE_KEY = 'kwanya_credits_balance';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface Conversation {
  id: string;
  user_id: string;
  title: string;
  language: string;
  created_at: string;
  updated_at: string;
}

interface AudioFileUpload {
  uri: string;
  type: string;
  name: string;
}

// Move outside component to avoid recreation on every render
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function KwanyaApp() {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const router = useRouter();
  const params = useLocalSearchParams<{ sidebar?: string }>();
  const { user, isAuthenticated } = useAuth();
  const { palette, themePreference, setThemePreference } = useTheme();
  const { t } = useLanguage();

  // State
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<Conversation[]>([]);
  const [sidebarMounted, setSidebarMounted] = useState(false);
  const [themeExpanded, setThemeExpanded] = useState(false);

  const flatListRef = useRef<FlatList>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const conversationRef = useRef<Conversation | null>(null);
  const creatingConversationRef = useRef<Promise<Conversation | null> | null>(null);
  const sidebarWidth = Math.min(windowWidth * 0.8, 320);
  const sidebarTranslateX = useRef(new Animated.Value(-sidebarWidth)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  // Keep refs in sync with state
  useEffect(() => { recordingRef.current = recording; }, [recording]);
  useEffect(() => { conversationRef.current = currentConversation; }, [currentConversation]);

  const prevAuthRef = useRef(isAuthenticated);

  // Use authenticated user ID when available, otherwise fall back to anonymous ID
  useEffect(() => {
    const wasAuthenticated = prevAuthRef.current;
    prevAuthRef.current = isAuthenticated;

    const loadOrCreateUserId = async () => {
      // On logout: clear chat state and caches, generate fresh anonymous ID
      if (wasAuthenticated && !isAuthenticated) {
        setMessages([]);
        setCurrentConversation(null);
        setConversationHistory([]);
        creatingConversationRef.current = null;

        // Clear conversation and message caches
        try {
          const cachedConvs = await AsyncStorage.getItem(CONVERSATIONS_CACHE_KEY);
          const keysToRemove = [CONVERSATIONS_CACHE_KEY, CREDITS_BALANCE_CACHE_KEY];
          if (cachedConvs) {
            const convs = JSON.parse(cachedConvs);
            convs.forEach((c: { id: string }) => keysToRemove.push(`kwanya_messages_${c.id}`));
          }
          await AsyncStorage.multiRemove(keysToRemove);
        } catch {}

        const freshId = 'anon-' + Date.now();
        await AsyncStorage.setItem(USER_ID_STORAGE_KEY, freshId);
        setUserId(freshId);
        return;
      }

      try {
        if (isAuthenticated && user) {
          setUserId(user.id);
          await AsyncStorage.setItem(USER_ID_STORAGE_KEY, user.id);
          return;
        }
        let storedId = await AsyncStorage.getItem(USER_ID_STORAGE_KEY);
        if (!storedId) {
          storedId = 'anon-' + Date.now();
          await AsyncStorage.setItem(USER_ID_STORAGE_KEY, storedId);
        }
        setUserId(storedId);
      } catch (error) {
        console.error('Failed to load/create user ID:', error);
        setUserId('anon-' + Date.now());
      }
    };
    loadOrCreateUserId();
  }, [isAuthenticated, user]);

  // Initialize app once userId is ready
  useEffect(() => {
    if (!userId) return;

    initializeApp();

    return () => {
      if (recordingRef.current) {
        recordingRef.current.unloadAsync();
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [userId]);


  // Sidebar open/close animation
  useEffect(() => {
    if (sidebarVisible) {
      setSidebarMounted(true);
      // Refresh history when sidebar opens
      if (userId) loadConversationHistory();
      sidebarTranslateX.setValue(-sidebarWidth);
      backdropOpacity.setValue(0);
      Animated.parallel([
        Animated.spring(sidebarTranslateX, {
          toValue: 0,
          useNativeDriver: true,
          damping: 22,
          stiffness: 220,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }

    if (sidebarMounted) {
      Animated.parallel([
        Animated.timing(sidebarTranslateX, {
          toValue: -sidebarWidth,
          duration: 200,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start(() => setSidebarMounted(false));
    }
  }, [
    sidebarVisible,
    sidebarMounted,
    sidebarWidth,
    sidebarTranslateX,
    backdropOpacity,
  ]);

  // Android back button closes sidebar
  useEffect(() => {
    if (!sidebarVisible) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      setSidebarVisible(false);
      return true;
    });
    return () => handler.remove();
  }, [sidebarVisible]);

  // Reopen sidebar when navigating back from account
  useEffect(() => {
    if (params.sidebar === '1') {
      setSidebarVisible(true);
      router.setParams({ sidebar: undefined });
    }
  }, [params.sidebar]);

  const copyToClipboard = async (text: string, label: string) => {
    if (!text.trim()) {
      return;
    }
    await Clipboard.setStringAsync(text);
    Alert.alert(t('common.copied'), t('common.copiedMessage').replace('{label}', label));
  };


  const initializeApp = async () => {
    try {
      await Audio.requestPermissionsAsync();

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      await loadConversationHistory();
    } catch (error) {
      console.error('Initialization error:', error);
      Alert.alert(t('common.error'), t('chat.failedInitialize'));
    }
  };

  const createConversation = async (): Promise<Conversation | null> => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/conversations`, {
        user_id: userId,
        language: 'ha',
      });
      setCurrentConversation(response.data);
      conversationRef.current = response.data;
      return response.data;
    } catch (error) {
      console.error('Failed to create conversation:', error);
      return null;
    }
  };

  const ensureConversation = async (): Promise<Conversation | null> => {
    // Use ref to avoid stale closure reads
    if (conversationRef.current) return conversationRef.current;
    // Mutex: if already creating, wait for that promise instead of creating a duplicate
    if (creatingConversationRef.current) return creatingConversationRef.current;
    const promise = createConversation();
    creatingConversationRef.current = promise;
    const result = await promise;
    creatingConversationRef.current = null;
    return result;
  };

  const loadConversationHistory = async () => {
    // 1. Show cached data instantly
    try {
      const cached = await AsyncStorage.getItem(CONVERSATIONS_CACHE_KEY);
      if (cached) {
        setConversationHistory(JSON.parse(cached));
      }
    } catch {}

    // 2. Fetch fresh data from server
    try {
      const response = await axios.get(`${BACKEND_URL}/api/conversations/${userId}`, { timeout: 10000 });
      if (response.data.success) {
        setConversationHistory(response.data.conversations);
        await AsyncStorage.setItem(CONVERSATIONS_CACHE_KEY, JSON.stringify(response.data.conversations));
      }
    } catch (error) {
      console.error('Failed to load conversation history:', error);
    }
  };

  const startNewChat = () => {
    setSidebarVisible(false);
    setMessages([]);
    setCurrentConversation(null);
    conversationRef.current = null;
    creatingConversationRef.current = null;
  };

  const loadConversation = async (conversation: Conversation) => {
    setSidebarVisible(false);
    setCurrentConversation(conversation);

    // 1. Show cached messages instantly
    let hasCached = false;
    try {
      const cached = await AsyncStorage.getItem(`kwanya_messages_${conversation.id}`);
      if (cached) {
        const cachedMessages = JSON.parse(cached);
        setMessages(cachedMessages);
        hasCached = cachedMessages.length > 0;
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 100);
      }
    } catch {}

    // 2. Fetch fresh messages from server
    try {
      const response = await axios.get(`${BACKEND_URL}/api/conversations/${conversation.id}/messages`, { timeout: 10000 });
      if (response.data.success) {
        setMessages(response.data.messages);
        await AsyncStorage.setItem(`kwanya_messages_${conversation.id}`, JSON.stringify(response.data.messages));
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 200);
      }
    } catch (error) {
      console.error('Failed to load messages:', error);
      if (!hasCached) {
        Alert.alert(t('common.error'), t('chat.failedLoadMessages'));
      }
    }
  };

  const autoNameConversation = async (conversationId: string, firstMessage: string) => {
    try {
      const title = firstMessage.length > 30
        ? firstMessage.substring(0, 30) + '...'
        : firstMessage;

      await axios.patch(`${BACKEND_URL}/api/conversations/${conversationId}`, {
        title: title
      });

      // Update the title in-place instead of reloading the entire list
      setConversationHistory((prev) => {
        const exists = prev.some((c) => c.id === conversationId);
        let updated: Conversation[];
        if (exists) {
          updated = prev.map((c) =>
            c.id === conversationId ? { ...c, title } : c
          );
        } else {
          // If conversation isn't in the list yet, add it to the top
          const newConv: Conversation = {
            id: conversationId,
            user_id: userId!,
            title,
            language: 'ha',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          updated = [newConv, ...prev];
        }
        // Sync cache so sidebar stays correct across app restarts
        AsyncStorage.setItem(CONVERSATIONS_CACHE_KEY, JSON.stringify(updated)).catch(() => {});
        return updated;
      });
    } catch (error) {
      console.error('Failed to auto-name conversation:', error);
    }
  };

  const startRecording = async () => {
    try {
      const { granted } = await Audio.getPermissionsAsync();
      if (!granted) {
        Alert.alert(t('chat.permissionRequired'), t('chat.micPermission'));
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      const { recording: newRecording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      setRecording(newRecording);
      setIsRecording(true);
      setRecordingTime(0);

      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);

    } catch (error) {
      console.error('Failed to start recording:', error);
      Alert.alert(t('common.error'), t('chat.failedStartRecording'));
    }
  };

  const stopRecording = async () => {
    try {
      if (!recording) return;

      setIsRecording(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }

      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();

      if (uri) {
        await transcribeAudio(uri);
      }

      setRecording(null);
      setRecordingTime(0);

    } catch (error) {
      console.error('Failed to stop recording:', error);
      // Ensure cleanup even on error
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setIsRecording(false);
      setRecording(null);
      setRecordingTime(0);
      Alert.alert(t('common.error'), t('chat.failedStopRecording'));
    }
  };

  const transcribeAudio = async (audioUri: string) => {
    const conversation = await ensureConversation();
    if (!conversation) return;

    try {
      const formData = new FormData();

      const audioFile: AudioFileUpload = {
        uri: audioUri,
        type: 'audio/m4a',
        name: 'recording.m4a',
      };

      formData.append('audio', audioFile as unknown as Blob);
      formData.append('user_id', userId!);
      formData.append('conversation_id', conversation.id);

      const response = await axios.post(
        `${BACKEND_URL}/api/speech-to-text`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
          timeout: 120000,
        }
      );

      if (response.data.success) {
        const transcribedText = response.data.transcription;
        const isFirstMessage = messages.length === 0;

        // Add transcribed text as a user message in the UI
        const userMessage: Message = {
          id: Date.now().toString(),
          role: 'user',
          content: transcribedText,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, userMessage]);

        if (isFirstMessage) {
          await autoNameConversation(conversation.id, transcribedText);
        }

        await getAIResponse(transcribedText, conversation);
      }

    } catch (error) {
      setIsLoading(false);
      const axiosErr = error as AxiosError<{ detail?: string }>;
      console.error('Transcription error:', error);
      const status = axiosErr.response?.status;
      if (status === 402) {
        const detail = axiosErr.response?.data?.detail || '';
        if (!isAuthenticated || detail.includes('Sign up')) {
          Alert.alert(
            t('chat.freeMessagesUsed'),
            t('chat.freeMessagesBody'),
            [
              { text: t('common.signUp'), onPress: () => router.push('/auth/signup') },
              { text: t('common.signIn'), onPress: () => router.push('/auth/signin') },
              { text: t('common.ok'), style: 'cancel' },
            ],
          );
        } else {
          Alert.alert(
            t('chat.insufficientCredits'),
            detail || t('chat.needMoreCreditsVoice'),
            [
              { text: t('chat.buyCredits'), onPress: () => router.push('/credits') },
              { text: t('common.ok'), style: 'cancel' },
            ],
          );
        }
      } else {
        let msg = axiosErr.response?.data?.detail || t('chat.failedTranscribe');
        if (status === 520 || status === 522 || status === 524) {
          msg = t('chat.serverSlowMessage');
        }
        Alert.alert(t('common.error'), msg);
      }
    }
  };

  const sendTextMessage = async () => {
    const text = inputText.trim();
    if (!text || isLoading) return;

    setIsLoading(true);
    const messageText = inputText;
    setInputText('');

    let conversation: Conversation | null;
    try {
      conversation = await ensureConversation();
    } catch (error) {
      console.error('Failed to create conversation:', error);
      conversation = null;
    }
    if (!conversation) {
      setIsLoading(false);
      setInputText(messageText);
      Alert.alert(t('chat.connectionError'), t('chat.connectionErrorMessage'));
      return;
    }

    const isFirstMessage = messages.length === 0;
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: messageText,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);

    if (isFirstMessage) {
      await autoNameConversation(conversation.id, messageText);
    }

    await getAIResponse(messageText, conversation);
  };

  const stopGenerating = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    cancelledRef.current = true;
    setIsLoading(false);
    setIsStreaming(false);

    // Cache partial messages so they persist on reload
    if (currentConversation) {
      setMessages(prev => {
        AsyncStorage.setItem(`kwanya_messages_${currentConversation.id}`, JSON.stringify(prev)).catch(() => {});
        return prev;
      });
    }
  };

  const getAIResponse = async (userMessage: string, conv?: Conversation) => {
    const activeConversation = conv || currentConversation;
    if (!activeConversation) return;

    cancelledRef.current = false;
    setIsLoading(true);

    const requestBody = JSON.stringify({
      conversation_id: activeConversation.id,
      user_id: userId,
      message: userMessage,
      language: 'ha',
    });

    // Helper: process SSE lines from accumulated response text
    let processedLength = 0;
    let placeholderCreated = false;

    const processSSEText = (fullText: string) => {
      const newText = fullText.substring(processedLength);
      processedLength = fullText.length;

      const lines = newText.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr);

          if (event.text) {
            if (!placeholderCreated) {
              placeholderCreated = true;
              setIsStreaming(true);
              const timestamp = new Date().toISOString();
              setMessages(prev => [...prev, { id: `temp_${Date.now()}`, role: 'assistant', content: event.text, timestamp }]);
            } else {
              setMessages(prev => {
                const updated = [...prev];
                const last = { ...updated[updated.length - 1] };
                last.content += event.text;
                updated[updated.length - 1] = last;
                return updated;
              });
            }
          }

          if (event.done) {
            setMessages(prev => {
              const updated = [...prev];
              const last = { ...updated[updated.length - 1] };
              last.id = event.message_id || last.id;
              updated[updated.length - 1] = last;
              AsyncStorage.setItem(`kwanya_messages_${activeConversation.id}`, JSON.stringify(updated)).catch(() => {});
              return updated;
            });
            if (event.credit_balance !== null && event.credit_balance !== undefined) {
              AsyncStorage.setItem(CREDITS_BALANCE_CACHE_KEY, String(event.credit_balance)).catch(() => {});
            }
          }

          if (event.error) {
            Alert.alert(t('common.error'), event.error || t('chat.failedGetResponse'));
          }
        } catch {
          // Ignore malformed JSON lines
        }
      }
    };

    // Handle credit / HTTP error responses
    const handleErrorDetail = (status: number, detail: string) => {
      if (status === 402) {
        if (!isAuthenticated || detail.includes('Sign up')) {
          Alert.alert(
            t('chat.freeMessagesUsed'),
            t('chat.freeMessagesBody'),
            [
              { text: t('common.signUp'), onPress: () => router.push('/auth/signup') },
              { text: t('common.signIn'), onPress: () => router.push('/auth/signin') },
              { text: t('common.ok'), style: 'cancel' },
            ],
          );
        } else {
          Alert.alert(
            t('chat.insufficientCredits'),
            detail || t('chat.needMoreCreditsChat'),
            [
              { text: t('chat.buyCredits'), onPress: () => router.push('/credits') },
              { text: t('common.ok'), style: 'cancel' },
            ],
          );
        }
        return;
      }
      const isCreditsError = detail.toLowerCase().includes('credit') || detail.toLowerCase().includes('kati');
      if (isCreditsError) {
        Alert.alert(
          t('chat.insufficientCredits'),
          detail || t('chat.needMoreCreditsChat'),
          [
            { text: t('chat.buyCredits'), onPress: () => router.push('/credits') },
            { text: t('common.ok'), style: 'cancel' },
          ],
        );
      } else {
        Alert.alert(t('common.error'), detail || t('chat.failedGetResponse'));
      }
    };

    // Use XHR on native (React Native fetch doesn't support ReadableStream)
    // Use fetch + getReader on web
    if (Platform.OS === 'web') {
      abortControllerRef.current = new AbortController();
      try {
        const response = await fetch(`${BACKEND_URL}/api/chat/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          let detail = '';
          try { const errBody = await response.json(); detail = errBody.detail || ''; } catch {}
          handleErrorDetail(response.status, detail);
          return;
        }
        if (cancelledRef.current) return;

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (cancelledRef.current) { reader.cancel(); break; }
          buffer += decoder.decode(value, { stream: true });
          // Process complete lines, keep partial line in buffer
          const lastNewline = buffer.lastIndexOf('\n');
          if (lastNewline !== -1) {
            const complete = buffer.substring(0, lastNewline + 1);
            buffer = buffer.substring(lastNewline + 1);
            processSSEText(complete);
            processedLength = 0; // reset since we pass fresh slices
          }
        }
        if (buffer) { processSSEText(buffer); processedLength = 0; }
      } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || cancelledRef.current)) {
          console.log('Request cancelled by user');
          return;
        }
        console.error('Chat error:', error);
        Alert.alert(t('common.error'), t('chat.failedGetResponse'));
      } finally {
        setIsLoading(false);
        setIsStreaming(false);
        abortControllerRef.current = null;
      }
    } else {
      // Native: use XMLHttpRequest which fires onprogress with partial responseText
      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          // Store so stopGenerating can abort
          const abortHandler = () => { xhr.abort(); };
          abortControllerRef.current = { signal: { addEventListener: () => {}, removeEventListener: () => {} }, abort: abortHandler } as unknown as AbortController;

          xhr.open('POST', `${BACKEND_URL}/api/chat/stream`);
          xhr.setRequestHeader('Content-Type', 'application/json');

          xhr.onprogress = () => {
            if (cancelledRef.current) { xhr.abort(); return; }
            processSSEText(xhr.responseText);
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              // Process any remaining data
              processSSEText(xhr.responseText);
              resolve();
            } else {
              let detail = '';
              try { const errBody = JSON.parse(xhr.responseText); detail = errBody.detail || ''; } catch {}
              handleErrorDetail(xhr.status, detail);
              resolve(); // don't reject — error already shown
            }
          };

          xhr.onerror = () => {
            reject(new Error('Network error'));
          };

          xhr.onabort = () => {
            console.log('Request cancelled by user');
            resolve();
          };

          xhr.send(requestBody);
        });
      } catch (error) {
        if (!cancelledRef.current) {
          console.error('Chat error:', error);
          Alert.alert(t('common.error'), t('chat.failedGetResponse'));
        }
      } finally {
        setIsLoading(false);
        setIsStreaming(false);
        abortControllerRef.current = null;
      }
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.role === 'user';

    return (
      <View
        style={[
          styles.messageContainer,
          isUser ? styles.userMessage : styles.assistantMessage,
        ]}
      >
        <Text
          style={[
            styles.messageText,
            isUser ? styles.userMessageText : styles.assistantMessageText,
          ]}
          selectable
        >
          {item.content}
        </Text>
        <Pressable
          onPress={() => copyToClipboard(item.content, 'Message')}
          hitSlop={6}
          style={[
            styles.copyButton,
            isUser ? styles.copyButtonUser : styles.copyButtonAssistant,
          ]}
        >
          <Ionicons
            name="copy-outline"
            size={14}
            color={isUser ? palette.userBubbleText : palette.textSubtle}
          />
        </Pressable>
      </View>
    );
  };

  // Extracted InputArea to avoid duplication
  const renderInputArea = (containerStyle: object) => (
    <View style={containerStyle}>
      {isLoading && !isRecording && !isStreaming && (
        <Text style={styles.thinkingText}>{t('chat.thinking')}</Text>
      )}

      {isRecording && (
        <View style={styles.recordingIndicator}>
          <View style={styles.recordingDot} />
          <Text style={styles.recordingText}>{t('chat.recording')}</Text>
          <Text style={styles.recordingText}>{formatTime(recordingTime)}</Text>
        </View>
      )}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.textInput}
          placeholder={t('chat.placeholder')}
          placeholderTextColor={palette.textSubtle}
          value={inputText}
          onChangeText={setInputText}
          multiline
          editable={!isLoading && !isRecording}
        />

        <Pressable
          style={[
            styles.iconButton,
            isRecording && styles.iconButtonRecording,
            isLoading && styles.iconButtonDisabled,
          ]}
          onPress={isRecording ? stopRecording : startRecording}
          disabled={isLoading}
        >
          <Ionicons
            name={isRecording ? 'stop' : 'mic'}
            size={24}
            color={palette.buttonText}
          />
        </Pressable>

        <Pressable
          style={[
            styles.iconButton,
            (!inputText.trim() || isLoading || isRecording) && styles.iconButtonDisabled,
          ]}
          onPress={sendTextMessage}
          disabled={!inputText.trim() || isLoading || isRecording}
        >
          <Ionicons name="send" size={20} color={palette.buttonText} />
        </Pressable>
      </View>
    </View>
  );

  // Memoize styles that depend on palette/insets/keyboardVisible
  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: palette.bg,
      paddingTop: insets.top,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: palette.bg,
      borderBottomWidth: 1,
      borderBottomColor: palette.border,
    },
    menuButton: {
      padding: 4,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: palette.text,
    },
    headerRight: {
      width: 36,
    },
    sidebarOverlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 100,
      elevation: 100,
      flexDirection: 'row',
    },
    sidebarBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: palette.overlay,
    },
    sidebar: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: windowWidth * 0.8,
      maxWidth: 320,
      backgroundColor: palette.bg,
      paddingTop: insets.top + 10,
      paddingBottom: insets.bottom,
      borderRightWidth: 1,
      borderRightColor: palette.border,
      zIndex: 101,
      elevation: 101,
    },
    sidebarHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingBottom: 16,
      borderBottomWidth: 1,
      borderBottomColor: palette.border,
    },
    sidebarTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: palette.text,
    },
    newChatButton: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 16,
      marginHorizontal: 12,
      marginTop: 12,
      backgroundColor: palette.surfaceAlt,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: palette.border,
    },
    newChatText: {
      marginLeft: 12,
      fontSize: 16,
      fontWeight: '600',
      color: palette.text,
    },
    menuOptions: {
      marginTop: 16,
      paddingHorizontal: 12,
    },
    menuOption: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 12,
      borderRadius: 8,
    },
    menuOptionText: {
      marginLeft: 12,
      fontSize: 16,
      color: palette.textMuted,
    },
    menuOptionSpacer: {
      flex: 1,
    },
    themeSection: {
      marginTop: 12,
      paddingHorizontal: 12,
    },
    themeTitle: {
      fontSize: 12,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: palette.textSubtle,
      marginBottom: 8,
      paddingHorizontal: 4,
    },
    themeOptionsRow: {
      flexDirection: 'row',
      gap: 8,
    },
    themeOptionButton: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.bg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    themeOptionButtonActive: {
      backgroundColor: palette.button,
      borderColor: palette.button,
    },
    themeOptionText: {
      fontSize: 12,
      fontWeight: '600',
      color: palette.textMuted,
    },
    themeOptionTextActive: {
      color: palette.buttonText,
    },
    chatHistorySection: {
      flex: 1,
      marginTop: 24,
      paddingHorizontal: 12,
      borderTopWidth: 1,
      borderTopColor: palette.border,
      paddingTop: 16,
    },
    chatHistoryTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textSubtle,
      marginBottom: 12,
      paddingHorizontal: 4,
    },
    chatHistoryList: {
      flex: 1,
    },
    chatHistoryItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 8,
      marginBottom: 4,
    },
    chatHistoryItemActive: {
      backgroundColor: palette.surfaceAlt,
    },
    chatHistoryItemText: {
      marginLeft: 10,
      fontSize: 15,
      color: palette.textMuted,
      flex: 1,
    },
    chatHistoryItemTextActive: {
      color: palette.text,
      fontWeight: '500',
    },
    chatDeleteButton: {
      padding: 4,
      marginLeft: 4,
    },
    noChatText: {
      fontSize: 14,
      color: palette.textSubtle,
      textAlign: 'center',
      paddingVertical: 20,
    },
    messagesList: {
      flexGrow: 1,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    messageContainer: {
      maxWidth: '80%',
      marginVertical: 4,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 18,
    },
    userMessage: {
      alignSelf: 'flex-end',
      backgroundColor: palette.userBubble,
      borderBottomRightRadius: 4,
    },
    assistantMessage: {
      alignSelf: 'flex-start',
      backgroundColor: palette.assistantBubble,
      borderBottomLeftRadius: 4,
    },
    messageText: {
      fontSize: 16,
      lineHeight: 22,
    },
    userMessageText: {
      color: palette.userBubbleText,
    },
    assistantMessageText: {
      color: palette.text,
    },
    copyButton: {
      alignSelf: 'flex-end',
      marginTop: 4,
      padding: 2,
    },
    copyButtonUser: {
      opacity: 0.6,
    },
    copyButtonAssistant: {
      opacity: 0.5,
    },
    emptyStateBody: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    welcomeSection: {
      alignItems: 'center',
    },
    emptyText: {
      fontSize: 18,
      color: palette.textMuted,
      textAlign: 'center',
      marginTop: 16,
    },
    bottomInputContainer: {
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: insets.bottom + 4,
      backgroundColor: palette.bg,
      borderTopWidth: 1,
      borderTopColor: palette.border,
    },
    thinkingText: {
      fontSize: 13,
      color: palette.textSubtle,
      paddingHorizontal: 4,
      paddingBottom: 6,
      fontStyle: 'italic',
    },
    recordingIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 12,
      backgroundColor: palette.surface,
      borderRadius: 12,
      marginBottom: 8,
    },
    recordingDot: {
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: palette.danger,
      marginRight: 8,
    },
    recordingText: {
      fontSize: 16,
      fontWeight: '600',
      color: palette.text,
      marginRight: 8,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    textInput: {
      flex: 1,
      minHeight: 40,
      maxHeight: 100,
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: 20,
      paddingHorizontal: 16,
      paddingVertical: 10,
      fontSize: 16,
      color: palette.text,
    },
    iconButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: palette.button,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconButtonRecording: {
      backgroundColor: palette.danger,
    },
    iconButtonDisabled: {
      backgroundColor: palette.disabled,
    },
    loadingContainer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      paddingHorizontal: 16,
      paddingVertical: 6,
    },
    stopGeneratingButton: {
      padding: 6,
    },
  }), [palette, insets]);

  // Don't render until userId is loaded
  if (!userId) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: palette.bg }}>
        <ActivityIndicator size="large" color={palette.text} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header with Menu Button */}
      <View style={styles.header}>
        <Pressable
          style={styles.menuButton}
          hitSlop={8}
          onPress={() => setSidebarVisible(true)}
        >
          <Ionicons name="menu" size={28} color={palette.text} />
        </Pressable>
        <View style={styles.headerRight} />
      </View>

      {/* Sidebar Overlay */}
      {sidebarMounted && (
        <View style={styles.sidebarOverlay} pointerEvents="box-none">
          <AnimatedPressable
            style={[styles.sidebarBackdrop, { opacity: backdropOpacity }]}
            onPress={() => setSidebarVisible(false)}
          />
          <Animated.View
            style={[
              styles.sidebar,
              { transform: [{ translateX: sidebarTranslateX }] },
            ]}
          >
            {/* Sidebar Header */}
            <View style={styles.sidebarHeader}>
              <Text style={styles.sidebarTitle}>{t('chat.menu')}</Text>
              <Pressable hitSlop={8} onPress={() => setSidebarVisible(false)}>
                <Ionicons name="close" size={28} color={palette.text} />
              </Pressable>
            </View>

            {/* New Chat Button */}
            <Pressable style={styles.newChatButton} onPress={startNewChat}>
              <Ionicons name="add-circle-outline" size={24} color={palette.text} />
              <Text style={styles.newChatText}>{t('chat.newChat')}</Text>
            </Pressable>

            {/* Menu Options */}
            <View style={styles.menuOptions}>
              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setSidebarVisible(false);
                  setSidebarMounted(false);
                  router.push('/account');
                }}
              >
                <Ionicons name="person-outline" size={22} color={palette.textMuted} />
                <Text style={styles.menuOptionText}>{t('chat.profile')}</Text>
                <View style={styles.menuOptionSpacer} />
                <Ionicons name="chevron-forward" size={18} color={palette.textMuted} />
              </Pressable>
              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setSidebarVisible(false);
                  setSidebarMounted(false);
                  router.push('/credits');
                }}
              >
                <Ionicons name="wallet-outline" size={22} color={palette.textMuted} />
                <Text style={styles.menuOptionText}>{t('chat.credits')}</Text>
                <View style={styles.menuOptionSpacer} />
                <Ionicons name="chevron-forward" size={18} color={palette.textMuted} />
              </Pressable>
              <Pressable
                style={styles.menuOption}
                onPress={() => setThemeExpanded((prev) => !prev)}
              >
                <Ionicons name="contrast-outline" size={22} color={palette.textMuted} />
                <Text style={styles.menuOptionText}>{t('chat.theme')}</Text>
                <View style={styles.menuOptionSpacer} />
                <Ionicons
                  name={themeExpanded ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={palette.textMuted}
                />
              </Pressable>
              <Pressable style={styles.menuOption} onPress={() => router.push('/settings')}>
                <Ionicons name="settings-outline" size={22} color={palette.textMuted} />
                <Text style={styles.menuOptionText}>{t('chat.settings')}</Text>
                <View style={styles.menuOptionSpacer} />
                <Ionicons name="chevron-forward" size={18} color={palette.textMuted} />
              </Pressable>
            </View>

            {themeExpanded && (
              <View style={styles.themeSection}>
                <Text style={styles.themeTitle}>{t('chat.theme')}</Text>
                <View style={styles.themeOptionsRow}>
                  <Pressable
                    style={[
                      styles.themeOptionButton,
                      themePreference === 'light' && styles.themeOptionButtonActive,
                    ]}
                    onPress={() => setThemePreference('light')}
                  >
                    <Text
                      style={[
                        styles.themeOptionText,
                        themePreference === 'light' && styles.themeOptionTextActive,
                      ]}
                    >
                      {t('chat.lightMode')}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.themeOptionButton,
                      themePreference === 'dark' && styles.themeOptionButtonActive,
                    ]}
                    onPress={() => setThemePreference('dark')}
                  >
                    <Text
                      style={[
                        styles.themeOptionText,
                        themePreference === 'dark' && styles.themeOptionTextActive,
                      ]}
                    >
                      {t('chat.darkMode')}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.themeOptionButton,
                      themePreference === 'system' && styles.themeOptionButtonActive,
                    ]}
                    onPress={() => setThemePreference('system')}
                  >
                    <Text
                      style={[
                        styles.themeOptionText,
                        themePreference === 'system' && styles.themeOptionTextActive,
                      ]}
                    >
                      {t('chat.system')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Chat History */}
            <View style={styles.chatHistorySection}>
              <Text style={styles.chatHistoryTitle}>
                {t('chat.chatHistory')}
              </Text>
              {conversationHistory.length === 0 ? (
                <Text style={styles.noChatText}>
                  {t('chat.noPreviousChats')}
                </Text>
              ) : (
                <FlatList
                  data={conversationHistory}
                  keyExtractor={(item) => item.id}
                  style={styles.chatHistoryList}
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({ item: conv }) => (
                    <Pressable
                      style={[
                        styles.chatHistoryItem,
                        currentConversation?.id === conv.id && styles.chatHistoryItemActive,
                      ]}
                      onPress={() => loadConversation(conv)}
                      onLongPress={() => {
                        Alert.alert(
                          t('chat.deleteChat'),
                          t('chat.deleteChatConfirm').replace('{title}', conv.title || t('chat.newConversation')),
                          [
                            { text: t('common.cancel'), style: 'cancel' },
                            {
                              text: t('common.delete'),
                              style: 'destructive',
                              onPress: async () => {
                                try {
                                  await axios.delete(`${BACKEND_URL}/api/conversations/${conv.id}?user_id=${userId}`);
                                  setConversationHistory((prev) => prev.filter((c) => c.id !== conv.id));
                                  if (currentConversation?.id === conv.id) {
                                    setCurrentConversation(null);
                                    setMessages([]);
                                  }
                                } catch {
                                  Alert.alert(t('common.error'), t('chat.failedDeleteConversation'));
                                }
                              },
                            },
                          ],
                        );
                      }}
                    >
                      <Ionicons
                        name="chatbubble-outline"
                        size={18}
                        color={currentConversation?.id === conv.id ? palette.text : palette.textMuted}
                      />
                      <Text
                        style={[
                          styles.chatHistoryItemText,
                          currentConversation?.id === conv.id && styles.chatHistoryItemTextActive,
                        ]}
                        numberOfLines={1}
                      >
                        {conv.title || t('chat.newConversation')}
                      </Text>
                      <Pressable
                        style={styles.chatDeleteButton}
                        onPress={() => {
                          Alert.alert(
                            t('chat.deleteChat'),
                            t('chat.deleteChatConfirm').replace('{title}', conv.title || t('chat.newConversation')),
                            [
                              { text: t('common.cancel'), style: 'cancel' },
                              {
                                text: t('common.delete'),
                                style: 'destructive',
                                onPress: async () => {
                                  try {
                                    await axios.delete(`${BACKEND_URL}/api/conversations/${conv.id}?user_id=${userId}`);
                                    setConversationHistory((prev) => prev.filter((c) => c.id !== conv.id));
                                    if (currentConversation?.id === conv.id) {
                                      setCurrentConversation(null);
                                      setMessages([]);
                                    }
                                  } catch {
                                    Alert.alert(t('common.error'), t('chat.failedDeleteConversation'));
                                  }
                                },
                              },
                            ],
                          );
                        }}
                        hitSlop={8}
                      >
                        <Ionicons name="trash-outline" size={16} color={palette.textMuted} />
                      </Pressable>
                    </Pressable>
                  )}
                />
              )}
            </View>
          </Animated.View>
        </View>
      )}

      {messages.length === 0 ? (
        /* Empty state - welcome centered, input at bottom */
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="padding"
          keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
        >
          <Pressable style={styles.emptyStateBody} onPress={Keyboard.dismiss}>
            <View style={styles.welcomeSection}>
              <Ionicons
                name="chatbubbles-outline"
                size={80}
                color={palette.textSubtle}
              />
              <Text style={styles.emptyText}>{t('chat.welcome')}</Text>
            </View>
          </Pressable>

          {/* Stop Button */}
          {isLoading && (
            <View style={styles.loadingContainer}>
              <Pressable
                style={styles.stopGeneratingButton}
                onPress={stopGenerating}
              >
                <Ionicons name="stop-circle" size={24} color={palette.text} />
              </Pressable>
            </View>
          )}

          {renderInputArea(styles.bottomInputContainer)}
        </KeyboardAvoidingView>
      ) : (
        /* Messages exist - normal layout with input at bottom */
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="padding"
          keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
        >
          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={(item) => item.id}
            style={{ flex: 1 }}
            contentContainerStyle={styles.messagesList}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
            onLayout={() => flatListRef.current?.scrollToEnd({ animated: false })}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={true}
          />

          {/* Stop Button */}
          {isLoading && (
            <View style={styles.loadingContainer}>
              <Pressable
                style={styles.stopGeneratingButton}
                onPress={stopGenerating}
              >
                <Ionicons name="stop-circle" size={24} color={palette.text} />
              </Pressable>
            </View>
          )}

          {/* Input at bottom - reused component */}
          {renderInputArea(styles.bottomInputContainer)}
        </KeyboardAvoidingView>
      )}
    </View>
  );
}
