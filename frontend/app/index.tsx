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

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8001';
const USER_ID_STORAGE_KEY = 'kwanya_user_id';

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

  // State
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
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

  // Use authenticated user ID when available, otherwise fall back to anonymous ID
  useEffect(() => {
    const loadOrCreateUserId = async () => {
      try {
        if (isAuthenticated && user) {
          setUserId(user.id);
          await AsyncStorage.setItem(USER_ID_STORAGE_KEY, user.id);
          return;
        }
        let storedId = await AsyncStorage.getItem(USER_ID_STORAGE_KEY);
        if (!storedId) {
          storedId = 'user-' + Date.now();
          await AsyncStorage.setItem(USER_ID_STORAGE_KEY, storedId);
        }
        setUserId(storedId);
      } catch (error) {
        console.error('Failed to load/create user ID:', error);
        setUserId('user-' + Date.now());
      }
    };
    loadOrCreateUserId();
  }, [isAuthenticated, user]);

  // Initialize app once userId is ready
  useEffect(() => {
    if (!userId) return;

    initializeApp();

    // Keyboard listeners
    const keyboardDidShowListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardVisible(true),
    );
    const keyboardDidHideListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardVisible(false),
    );

    return () => {
      if (recordingRef.current) {
        recordingRef.current.unloadAsync();
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      keyboardDidShowListener.remove();
      keyboardDidHideListener.remove();
    };
  }, [userId]);


  // Sidebar open/close animation
  useEffect(() => {
    if (sidebarVisible) {
      setSidebarMounted(true);
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
    Alert.alert('Copied', `${label} copied to clipboard.`);
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
      Alert.alert('Error', 'Failed to initialize app. Please check permissions.');
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
    try {
      const response = await axios.get(`${BACKEND_URL}/api/conversations/${userId}`);
      if (response.data.success) {
        setConversationHistory(response.data.conversations);
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
    try {
      const response = await axios.get(`${BACKEND_URL}/api/conversations/${conversation.id}/messages`);
      if (response.data.success) {
        setMessages(response.data.messages);
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 200);
      }
    } catch (error) {
      console.error('Failed to load messages:', error);
      Alert.alert('Error', 'Failed to load conversation messages');
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

      await loadConversationHistory();
    } catch (error) {
      console.error('Failed to auto-name conversation:', error);
    }
  };

  const startRecording = async () => {
    try {
      const { granted } = await Audio.getPermissionsAsync();
      if (!granted) {
        Alert.alert('Permission required', 'Microphone permission is needed to record audio.');
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
      Alert.alert('Error', 'Failed to start recording');
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
      Alert.alert('Error', 'Failed to stop recording');
    }
  };

  const transcribeAudio = async (audioUri: string) => {
    const conversation = await ensureConversation();
    if (!conversation) return;

    setIsLoading(true);
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

        const userMessage: Message = {
          id: response.data.message_id,
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
      const axiosErr = error as AxiosError<{ detail?: string }>;
      console.error('Transcription error:', error);
      const status = axiosErr.response?.status;
      let msg = axiosErr.response?.data?.detail || 'Failed to transcribe audio';
      if (status === 520 || status === 522 || status === 524) {
        msg = 'Server is taking too long to respond. The speech model may still be loading — please try again in a moment.';
      }
      Alert.alert('Error', msg);
    } finally {
      setIsLoading(false);
    }
  };

  const sendTextMessage = async () => {
    if (!inputText.trim() || isLoading) return;

    const conversation = await ensureConversation();
    if (!conversation) return;

    const isFirstMessage = messages.length === 0;
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputText,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    const messageText = inputText;
    setInputText('');

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
  };

  const getAIResponse = async (userMessage: string, conv?: Conversation) => {
    const activeConversation = conv || currentConversation;
    if (!activeConversation) return;

    abortControllerRef.current = new AbortController();
    cancelledRef.current = false;
    setIsLoading(true);

    try {
      // Backend /chat endpoint now saves the user message to DB
      const response = await axios.post(`${BACKEND_URL}/api/chat`, {
        conversation_id: activeConversation.id,
        user_id: userId,
        message: userMessage,
        language: 'ha',
      }, {
        signal: abortControllerRef.current.signal
      });

      if (cancelledRef.current) return;

      if (response.data.success) {
        const assistantMessage: Message = {
          id: response.data.message_id,
          role: 'assistant',
          content: response.data.response,
          timestamp: new Date().toISOString(),
        };

        setMessages((prev) => [...prev, assistantMessage]);
      }

    } catch (error) {
      const axiosErr = error as AxiosError<{ detail?: string }>;
      if (axios.isCancel(error) || (error instanceof Error && error.name === 'AbortError')) {
        console.log('Request cancelled by user');
        return;
      }
      console.error('Chat error:', error);
      Alert.alert('Error', axiosErr.response?.data?.detail || 'Failed to get response');
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
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
      <Pressable
        onLongPress={() => copyToClipboard(item.content, 'Message')}
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
        >
          {item.content}
        </Text>
      </Pressable>
    );
  };

  // Extracted InputArea to avoid duplication
  const renderInputArea = (containerStyle: object) => (
    <View style={containerStyle}>
      {isRecording && (
        <View style={styles.recordingIndicator}>
          <View style={styles.recordingDot} />
          <Text style={styles.recordingText}>Recording</Text>
          <Text style={styles.recordingText}>{formatTime(recordingTime)}</Text>
        </View>
      )}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.textInput}
          placeholder="Type in Hausa..."
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

        {inputText.trim().length > 0 && (
          <Pressable
            style={[
              styles.iconButton,
              isLoading && styles.iconButtonDisabled,
            ]}
            onPress={sendTextMessage}
            disabled={isLoading || isRecording}
          >
            <Ionicons name="send" size={20} color={palette.buttonText} />
          </Pressable>
        )}
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
      paddingVertical: 12,
      paddingBottom: keyboardVisible ? 12 : Math.max(insets.bottom, 12),
      backgroundColor: palette.bg,
      borderTopWidth: 1,
      borderTopColor: palette.border,
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
  }), [palette, insets, keyboardVisible]);

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
              <Text style={styles.sidebarTitle}>Menu</Text>
              <Pressable hitSlop={8} onPress={() => setSidebarVisible(false)}>
                <Ionicons name="close" size={28} color={palette.text} />
              </Pressable>
            </View>

            {/* New Chat Button */}
            <Pressable style={styles.newChatButton} onPress={startNewChat}>
              <Ionicons name="add-circle-outline" size={24} color={palette.text} />
              <Text style={styles.newChatText}>New Chat</Text>
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
                <Text style={styles.menuOptionText}>Profile</Text>
                <View style={styles.menuOptionSpacer} />
                <Ionicons name="chevron-forward" size={18} color={palette.textMuted} />
              </Pressable>
              <Pressable style={[styles.menuOption, { opacity: 0.4 }]} disabled>
                <Ionicons name="wallet-outline" size={22} color={palette.textMuted} />
                <Text style={styles.menuOptionText}>Credits</Text>
                <View style={styles.menuOptionSpacer} />
                <Text style={{ fontSize: 11, color: palette.textSubtle }}>Coming soon</Text>
              </Pressable>
              <Pressable
                style={styles.menuOption}
                onPress={() => setThemeExpanded((prev) => !prev)}
              >
                <Ionicons name="contrast-outline" size={22} color={palette.textMuted} />
                <Text style={styles.menuOptionText}>Theme</Text>
                <View style={styles.menuOptionSpacer} />
                <Ionicons
                  name={themeExpanded ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={palette.textMuted}
                />
              </Pressable>
              <Pressable style={[styles.menuOption, { opacity: 0.4 }]} disabled>
                <Ionicons name="settings-outline" size={22} color={palette.textMuted} />
                <Text style={styles.menuOptionText}>Settings</Text>
                <View style={styles.menuOptionSpacer} />
                <Text style={{ fontSize: 11, color: palette.textSubtle }}>Coming soon</Text>
              </Pressable>
            </View>

            {themeExpanded && (
              <View style={styles.themeSection}>
                <Text style={styles.themeTitle}>Theme</Text>
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
                      Light Mode
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
                      Dark Mode
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
                      System
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Chat History */}
            <View style={styles.chatHistorySection}>
              <Text style={styles.chatHistoryTitle}>
                Chat History
              </Text>
              <ScrollView style={styles.chatHistoryList} showsVerticalScrollIndicator={false}>
                {conversationHistory.length === 0 ? (
                  <Text style={styles.noChatText}>
                    No previous chats
                  </Text>
                ) : (
                  conversationHistory.map((conv) => (
                    <Pressable
                      key={conv.id}
                      style={[
                        styles.chatHistoryItem,
                        currentConversation?.id === conv.id && styles.chatHistoryItemActive,
                      ]}
                      onPress={() => loadConversation(conv)}
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
                        {conv.title || 'New Conversation'}
                      </Text>
                    </Pressable>
                  ))
                )}
              </ScrollView>
            </View>
          </Animated.View>
        </View>
      )}

      {messages.length === 0 ? (
        /* Empty state - welcome centered, input at bottom */
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="padding"
          keyboardVerticalOffset={insets.top}
        >
          <Pressable style={styles.emptyStateBody} onPress={Keyboard.dismiss}>
            <View style={styles.welcomeSection}>
              <Ionicons
                name="chatbubbles-outline"
                size={80}
                color={palette.textSubtle}
              />
              <Text style={styles.emptyText}>Barka da zuwa!</Text>
            </View>
          </Pressable>

          {renderInputArea(styles.bottomInputContainer)}
        </KeyboardAvoidingView>
      ) : (
        /* Messages exist - normal layout with input at bottom */
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="padding"
          keyboardVerticalOffset={insets.top}
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
