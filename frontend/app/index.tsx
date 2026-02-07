import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  useColorScheme,
  Keyboard,
  Modal,
  ScrollView,
  Dimensions,
  Animated,
  Easing,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Audio } from 'expo-av';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8001';

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

export default function KwanyaApp() {
  const colorScheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const [themePreference, setThemePreference] = useState<'light' | 'dark' | 'system'>('system');
  const isDark = themePreference === 'system' ? colorScheme === 'dark' : themePreference === 'dark';

  const palette = {
    bg: isDark ? '#000000' : '#ffffff',
    surface: isDark ? '#0d0d0d' : '#f7f7f7',
    surfaceAlt: isDark ? '#151515' : '#f2f2f2',
    text: isDark ? '#ffffff' : '#000000',
    textMuted: isDark ? '#c7c7c7' : '#333333',
    textSubtle: isDark ? '#9a9a9a' : '#666666',
    border: isDark ? '#2a2a2a' : '#e5e5e5',
    overlay: 'rgba(0,0,0,0.55)',
    button: isDark ? '#ffffff' : '#000000',
    buttonText: isDark ? '#000000' : '#ffffff',
    disabled: isDark ? '#2f2f2f' : '#d9d9d9',
  };
  
  // State
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [userId] = useState('user-' + Date.now());
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isAudioPaused, setIsAudioPaused] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<Conversation[]>([]);
  const [isCancelled, setIsCancelled] = useState(false);
  const [sidebarMounted, setSidebarMounted] = useState(false);
  const [themeExpanded, setThemeExpanded] = useState(false);
  
  const flatListRef = useRef<FlatList>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sidebarWidth = Math.min(Dimensions.get('window').width * 0.8, 320);
  const sidebarTranslateX = useRef(new Animated.Value(-sidebarWidth)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const AnimatedTouchableOpacity = Animated.createAnimatedComponent(TouchableOpacity);
  const THEME_STORAGE_KEY = 'themePreference';

  // Initialize app
  useEffect(() => {
    initializeApp();
    
    // Keyboard listeners for Android
    const keyboardDidShowListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => {
        setKeyboardVisible(true);
      }
    );
    const keyboardDidHideListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardVisible(false);
      }
    );

    return () => {
      if (recording) {
        recording.unloadAsync();
      }
      if (sound) {
        sound.unloadAsync();
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      keyboardDidShowListener.remove();
      keyboardDidHideListener.remove();
    };
  }, []);

  useEffect(() => {
    const loadThemePreference = async () => {
      try {
        const stored = await AsyncStorage.getItem(THEME_STORAGE_KEY);
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          setThemePreference(stored);
        }
      } catch (error) {
        console.error('Failed to load theme preference:', error);
      }
    };

    loadThemePreference();
  }, []);

  useEffect(() => {
    if (sidebarVisible) {
      setSidebarMounted(true);
      sidebarTranslateX.setValue(-sidebarWidth);
      backdropOpacity.setValue(0);
      Animated.parallel([
        Animated.timing(sidebarTranslateX, {
          toValue: 0,
          duration: 250,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 200,
          easing: Easing.out(Easing.quad),
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
          duration: 150,
          easing: Easing.in(Easing.quad),
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

  const copyToClipboard = async (text: string, label: string) => {
    if (!text.trim()) {
      return;
    }
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', `${label} copied to clipboard.`);
  };

  const applyThemePreference = async (value: 'light' | 'dark' | 'system') => {
    setThemePreference(value);
    try {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, value);
    } catch (error) {
      console.error('Failed to save theme preference:', error);
    }
  };

  const initializeApp = async () => {
    try {
      // Request audio permissions
      await Audio.requestPermissionsAsync();
      
      // Set audio mode
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      // Load conversation history
      await loadConversationHistory();

      // Create or load conversation
      await createConversation();
    } catch (error) {
      console.error('Initialization error:', error);
      Alert.alert('Error', 'Failed to initialize app. Please check permissions.');
    }
  };

  const createConversation = async () => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/conversations`, {
        user_id: userId,
        language: 'ha',
      });
      setCurrentConversation(response.data);
      // Refresh conversation history
      await loadConversationHistory();
    } catch (error) {
      console.error('Failed to create conversation:', error);
    }
  };

  // Load conversation history
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

  // Start a new chat
  const startNewChat = async () => {
    setSidebarVisible(false);
    setMessages([]);
    setCurrentConversation(null);
    await createConversation();
  };

  // Load a specific conversation
  const loadConversation = async (conversation: Conversation) => {
    setSidebarVisible(false);
    setCurrentConversation(conversation);
    try {
      const response = await axios.get(`${BACKEND_URL}/api/conversations/${conversation.id}/messages`);
      if (response.data.success) {
        setMessages(response.data.messages);
      }
    } catch (error) {
      console.error('Failed to load messages:', error);
    }
  };

  // Auto-name conversation based on first message
  const autoNameConversation = async (conversationId: string, firstMessage: string) => {
    try {
      // Create a short title from the first message (max 30 chars)
      const title = firstMessage.length > 30 
        ? firstMessage.substring(0, 30) + '...' 
        : firstMessage;
      
      // Update conversation title in database
      await axios.patch(`${BACKEND_URL}/api/conversations/${conversationId}`, {
        title: title
      });
      
      // Refresh history
      await loadConversationHistory();
    } catch (error) {
      console.error('Failed to auto-name conversation:', error);
    }
  };

  // Voice recording functions
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

      // Start timer
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
      }

      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();

      if (uri && currentConversation) {
        await transcribeAudio(uri);
      }

      setRecording(null);
      setRecordingTime(0);

    } catch (error) {
      console.error('Failed to stop recording:', error);
      Alert.alert('Error', 'Failed to stop recording');
    }
  };

  const transcribeAudio = async (audioUri: string) => {
    if (!currentConversation) return;

    setIsLoading(true);
    try {
      const formData = new FormData();
      
      // Create file object for upload
      const audioFile: any = {
        uri: audioUri,
        type: 'audio/m4a',
        name: 'recording.m4a',
      };

      formData.append('audio', audioFile);
      formData.append('user_id', userId);
      formData.append('conversation_id', currentConversation.id);

      const response = await axios.post(
        `${BACKEND_URL}/api/speech-to-text`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
        }
      );

      if (response.data.success) {
        const transcribedText = response.data.transcription;
        
        // Add user message to UI
        const userMessage: Message = {
          id: response.data.message_id,
          role: 'user',
          content: transcribedText,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, userMessage]);

        // Get AI response
        await getAIResponse(transcribedText);
      }

    } catch (error: any) {
      console.error('Transcription error:', error);
      Alert.alert('Error', error.response?.data?.detail || 'Failed to transcribe audio');
    } finally {
      setIsLoading(false);
    }
  };

  const sendTextMessage = async () => {
    if (!inputText.trim() || !currentConversation) return;

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

    // Auto-name conversation on first message
    if (isFirstMessage) {
      await autoNameConversation(currentConversation.id, messageText);
    }

    await getAIResponse(messageText);
  };

  // Stop generating response (cancel chat and TTS)
  const stopGenerating = async () => {
    // Cancel any ongoing requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    // Stop any playing audio
    if (sound) {
      try {
        await sound.stopAsync();
        await sound.unloadAsync();
        setSound(null);
      } catch (e) {
        // Ignore errors
      }
    }
    
    setIsCancelled(true);
    setIsLoading(false);
    setIsPlayingAudio(false);
    setIsAudioPaused(false);
  };

  const getAIResponse = async (userMessage: string) => {
    if (!currentConversation) return;

    // Create new abort controller for this request
    abortControllerRef.current = new AbortController();
    setIsCancelled(false);
    setIsLoading(true);
    
    try {
      const response = await axios.post(`${BACKEND_URL}/api/chat`, {
        conversation_id: currentConversation.id,
        user_id: userId,
        message: userMessage,
        language: 'ha',
      }, {
        signal: abortControllerRef.current.signal
      });

      // Check if cancelled before continuing
      if (isCancelled) return;

      if (response.data.success) {
        const assistantMessage: Message = {
          id: response.data.message_id,
          role: 'assistant',
          content: response.data.response,
          timestamp: new Date().toISOString(),
        };

        setMessages((prev) => [...prev, assistantMessage]);

        // Check if cancelled before playing TTS
       // if (!isCancelled) {
          // Generate and play TTS for assistant response
       //   await playTextToSpeech(response.data.response);
        //}
      }

    } catch (error: any) {
      if (axios.isCancel(error) || error.name === 'AbortError') {
        console.log('Request cancelled by user');
        return;
      }
      console.error('Chat error:', error);
      Alert.alert('Error', error.response?.data?.detail || 'Failed to get response');
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };

  const playTextToSpeech = async (text: string) => {
    // Check if cancelled
    if (isCancelled) return;
    
    try {
      // Create abort controller for TTS request
      const ttsAbortController = new AbortController();
      
      // Using TWB Voice Hausa TTS (Fully Optimized - Female Voice)
      const response = await axios.post(`${BACKEND_URL}/api/text-to-speech`, {
        text,
        language: 'ha',
      }, {
        signal: ttsAbortController.signal
      });

      // Check if cancelled before playing audio
      if (isCancelled) return;

      if (response.data.success) {
        const audioContent = response.data.audio_content;
        
        // Create audio from base64 (WAV format from TWB Voice TTS)
        const base64Audio = `data:audio/wav;base64,${audioContent}`;
        
        // Unload previous sound
        if (sound) {
          await sound.unloadAsync();
        }

        const { sound: newSound } = await Audio.Sound.createAsync(
          { uri: base64Audio },
          { shouldPlay: true }
        );

        setSound(newSound);

        // Set playback status callback
        newSound.setOnPlaybackStatusUpdate((status: any) => {
          if (status.isPlaying && !isPlayingAudio) {
            // Audio has started playing - now show the controls
            setIsPlayingAudio(true);
          }
          if (status.didJustFinish) {
            setIsPlayingAudio(false);
            setIsAudioPaused(false);
          }
        });
      }

    } catch (error) {
      console.error('TTS error:', error);
      setIsPlayingAudio(false);
    }
  };

  // Stop audio playback
  const stopAudio = async () => {
    try {
      if (sound) {
        await sound.stopAsync();
        await sound.unloadAsync();
        setSound(null);
      }
      setIsPlayingAudio(false);
      setIsAudioPaused(false);
    } catch (error) {
      console.error('Error stopping audio:', error);
      setIsPlayingAudio(false);
      setIsAudioPaused(false);
    }
  };

  // Pause/Resume audio playback
  const togglePauseAudio = async () => {
    try {
      if (sound) {
        if (isAudioPaused) {
          await sound.playAsync();
          setIsAudioPaused(false);
        } else {
          await sound.pauseAsync();
          setIsAudioPaused(true);
        }
      }
    } catch (error) {
      console.error('Error toggling audio pause:', error);
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
      <TouchableOpacity
        activeOpacity={0.85}
        onLongPress={() => copyToClipboard(item.content, 'Message')}
        style={[
          styles.messageContainer,
          isUser ? styles.userMessage : styles.assistantMessage,
          isDark && (isUser ? styles.userMessageDark : styles.assistantMessageDark),
        ]}
      >
        <Text
          style={[
            styles.messageText,
            isUser ? styles.userMessageText : styles.assistantMessageText,
            isDark && styles.messageTextDark,
          ]}
        >
          {item.content}
        </Text>
      </TouchableOpacity>
    );
  };

  const styles = StyleSheet.create({
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
    headerTitleDark: {
      color: palette.text,
    },
    headerRight: {
      width: 36,
    },
    sidebarOverlay: {
      flex: 1,
      flexDirection: 'row',
    },
    sidebarBackdrop: {
      flex: 1,
      backgroundColor: palette.overlay,
    },
    sidebar: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: Dimensions.get('window').width * 0.8,
      maxWidth: 320,
      backgroundColor: palette.bg,
      paddingTop: insets.top + 10,
      paddingBottom: insets.bottom,
      borderRightWidth: 1,
      borderRightColor: palette.border,
    },
    sidebarDark: {
      backgroundColor: palette.bg,
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
    sidebarTitleDark: {
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
    menuOptionTextDark: {
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
    chatHistoryTitleDark: {
      color: palette.textSubtle,
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
    chatHistoryItemDark: {
      backgroundColor: 'transparent',
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
    chatHistoryItemTextDark: {
      color: palette.textMuted,
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
    noChatTextDark: {
      color: palette.textSubtle,
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
      borderWidth: 1,
      borderColor: palette.border,
    },
    userMessage: {
      alignSelf: 'flex-end',
      backgroundColor: palette.button,
      borderBottomRightRadius: 4,
    },
    userMessageDark: {
      backgroundColor: palette.button,
    },
    assistantMessage: {
      alignSelf: 'flex-start',
      backgroundColor: palette.surface,
      borderBottomLeftRadius: 4,
    },
    assistantMessageDark: {
      backgroundColor: palette.surface,
    },
    messageText: {
      fontSize: 16,
      lineHeight: 22,
    },
    userMessageText: {
      color: palette.buttonText,
    },
    assistantMessageText: {
      color: palette.text,
    },
    messageTextDark: {
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 40,
    },
    emptyText: {
      fontSize: 18,
      color: palette.textMuted,
      textAlign: 'center',
      marginTop: 16,
    },
    emptySubtext: {
      fontSize: 14,
      color: palette.textSubtle,
      textAlign: 'center',
      marginTop: 8,
    },
    centeredInputWrapper: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      top: 0,
      justifyContent: 'center',
      alignItems: 'center',
      pointerEvents: 'box-none',
    },
    welcomeSection: {
      alignItems: 'center',
      marginBottom: 32,
    },
    inputContainer: {
      width: '90%',
      maxWidth: 600,
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: palette.bg,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: 24,
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
      backgroundColor: palette.text,
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
      borderWidth: 1,
      borderColor: palette.text,
    },
    iconButtonDisabled: {
      backgroundColor: palette.disabled,
    },
    loadingContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: palette.surface,
      borderTopWidth: 1,
      borderTopColor: palette.border,
    },
    loadingIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    loadingText: {
      marginLeft: 10,
      fontSize: 14,
      color: palette.textMuted,
      fontWeight: '500',
    },
    loadingTextDark: {
      color: palette.textMuted,
    },
    stopGeneratingButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: palette.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: palette.text,
    },
    stopGeneratingText: {
      marginLeft: 4,
      fontSize: 14,
      color: palette.text,
      fontWeight: '600',
    },
    audioPlayingContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: palette.surface,
      borderTopWidth: 1,
      borderTopColor: palette.border,
    },
    audioPlayingIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    audioPlayingText: {
      marginLeft: 8,
      fontSize: 14,
      color: palette.textMuted,
      fontWeight: '500',
    },
    audioPlayingTextDark: {
      color: palette.textMuted,
    },
    audioControlButtons: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    pauseAudioButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: palette.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: palette.text,
    },
    pauseAudioText: {
      marginLeft: 4,
      fontSize: 14,
      color: palette.text,
      fontWeight: '600',
    },
    stopAudioButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: palette.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: palette.text,
    },
    stopAudioText: {
      marginLeft: 4,
      fontSize: 14,
      color: palette.text,
      fontWeight: '600',
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 40,
    },
    emptyText: {
      fontSize: 18,
      color: palette.textMuted,
      textAlign: 'center',
      marginTop: 16,
    },
    emptySubtext: {
      fontSize: 14,
      color: palette.textSubtle,
      textAlign: 'center',
      marginTop: 8,
    },
  });

  return (
    <View style={styles.container}>
      {/* Header with Menu Button */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.menuButton}
          onPress={() => setSidebarVisible(true)}
        >
          <Ionicons name="menu" size={28} color={palette.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, isDark && styles.headerTitleDark]}>Kwanya</Text>
        <View style={styles.headerRight} />
      </View>

      {/* Sidebar Modal */}
      <Modal
        visible={sidebarMounted}
        animationType="none"
        transparent={true}
        onRequestClose={() => setSidebarVisible(false)}
      >
        <View style={styles.sidebarOverlay}>
          <AnimatedTouchableOpacity 
            style={[styles.sidebarBackdrop, { opacity: backdropOpacity }]} 
            activeOpacity={1}
            onPress={() => setSidebarVisible(false)}
          />
          <Animated.View
            style={[
              styles.sidebar,
              isDark && styles.sidebarDark,
              { transform: [{ translateX: sidebarTranslateX }] },
            ]}
          >
            {/* Sidebar Header */}
            <View style={styles.sidebarHeader}>
              <Text style={[styles.sidebarTitle, isDark && styles.sidebarTitleDark]}>Menu</Text>
              <TouchableOpacity onPress={() => setSidebarVisible(false)}>
                <Ionicons name="close" size={28} color={palette.text} />
              </TouchableOpacity>
            </View>

            {/* New Chat Button */}
            <TouchableOpacity style={styles.newChatButton} onPress={startNewChat}>
              <Ionicons name="add-circle-outline" size={24} color={palette.text} />
              <Text style={styles.newChatText}>New Chat</Text>
            </TouchableOpacity>

            {/* Menu Options */}
            <View style={styles.menuOptions}>
              <TouchableOpacity style={styles.menuOption}>
                <Ionicons name="person-outline" size={22} color={palette.textMuted} />
                <Text style={[styles.menuOptionText, isDark && styles.menuOptionTextDark]}>Account</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.menuOption}
                onPress={() => setThemeExpanded((prev) => !prev)}
              >
                <Ionicons name="contrast-outline" size={22} color={palette.textMuted} />
                <Text style={[styles.menuOptionText, isDark && styles.menuOptionTextDark]}>Theme</Text>
                <View style={styles.menuOptionSpacer} />
                <Ionicons
                  name={themeExpanded ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={palette.textMuted}
                />
              </TouchableOpacity>
              <TouchableOpacity style={styles.menuOption}>
                <Ionicons name="settings-outline" size={22} color={palette.textMuted} />
                <Text style={[styles.menuOptionText, isDark && styles.menuOptionTextDark]}>Settings</Text>
              </TouchableOpacity>
            </View>

            {themeExpanded && (
              <View style={styles.themeSection}>
                <Text style={styles.themeTitle}>Theme</Text>
                <View style={styles.themeOptionsRow}>
                  <TouchableOpacity
                    style={[
                      styles.themeOptionButton,
                      themePreference === 'light' && styles.themeOptionButtonActive,
                    ]}
                    onPress={() => applyThemePreference('light')}
                  >
                    <Text
                      style={[
                        styles.themeOptionText,
                        themePreference === 'light' && styles.themeOptionTextActive,
                      ]}
                    >
                      Light Mode
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.themeOptionButton,
                      themePreference === 'dark' && styles.themeOptionButtonActive,
                    ]}
                    onPress={() => applyThemePreference('dark')}
                  >
                    <Text
                      style={[
                        styles.themeOptionText,
                        themePreference === 'dark' && styles.themeOptionTextActive,
                      ]}
                    >
                      Dark Mode
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.themeOptionButton,
                      themePreference === 'system' && styles.themeOptionButtonActive,
                    ]}
                    onPress={() => applyThemePreference('system')}
                  >
                    <Text
                      style={[
                        styles.themeOptionText,
                        themePreference === 'system' && styles.themeOptionTextActive,
                      ]}
                    >
                      System
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Chat History */}
            <View style={styles.chatHistorySection}>
              <Text style={[styles.chatHistoryTitle, isDark && styles.chatHistoryTitleDark]}>
                Chat History
              </Text>
              <ScrollView style={styles.chatHistoryList} showsVerticalScrollIndicator={false}>
                {conversationHistory.length === 0 ? (
                  <Text style={[styles.noChatText, isDark && styles.noChatTextDark]}>
                    No previous chats
                  </Text>
                ) : (
                  conversationHistory.map((conv) => (
                    <TouchableOpacity
                      key={conv.id}
                      style={[
                        styles.chatHistoryItem,
                        currentConversation?.id === conv.id && styles.chatHistoryItemActive,
                        isDark && styles.chatHistoryItemDark,
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
                          isDark && styles.chatHistoryItemTextDark,
                        ]}
                        numberOfLines={1}
                      >
                        {conv.title || 'New Conversation'}
                      </Text>
                    </TouchableOpacity>
                  ))
                )}
              </ScrollView>
            </View>
          </Animated.View>
        </View>
      </Modal>

      {messages.length === 0 ? (
        /* Empty state - centered welcome and input */
        <View style={styles.centeredInputWrapper}>
          <View style={styles.welcomeSection}>
            <Ionicons
              name="chatbubbles-outline"
              size={80}
              color={palette.textSubtle}
            />
            <Text style={styles.emptyText}>Barka da zuwa!</Text>
          </View>

          <View style={styles.inputContainer}>
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

              <TouchableOpacity
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
              </TouchableOpacity>

              {inputText.trim().length > 0 && (
                <TouchableOpacity
                  style={[
                    styles.iconButton,
                    isLoading && styles.iconButtonDisabled,
                  ]}
                  onPress={sendTextMessage}
                  disabled={isLoading || isRecording}
                >
                  <Ionicons name="send" size={20} color={palette.buttonText} />
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      ) : (
        /* Messages exist - normal layout with input at bottom */
        <KeyboardAvoidingView 
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
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

          {/* Loading Indicator with Stop Button */}
          {isLoading && (
            <View style={styles.loadingContainer}>
              <View style={styles.loadingIndicator}>
                <ActivityIndicator size="small" color={palette.text} />
                <Text style={[styles.loadingText, isDark && styles.loadingTextDark]}>
                  Generating response...
                </Text>
              </View>
              <TouchableOpacity
                style={styles.stopGeneratingButton}
                onPress={stopGenerating}
              >
                <Ionicons name="stop-circle" size={24} color={palette.text} />
                <Text style={styles.stopGeneratingText}>Stop</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Audio Playing Indicator with Pause/Play and Stop Buttons */}
          {isPlayingAudio && (
            <View style={styles.audioPlayingContainer}>
              <View style={styles.audioPlayingIndicator}>
                <Ionicons name={isAudioPaused ? "volume-mute" : "volume-high"} size={20} color={palette.text} />
                <Text style={[styles.audioPlayingText, isDark && styles.audioPlayingTextDark]}>
                  {isAudioPaused ? 'Paused' : 'Playing audio...'}
                </Text>
              </View>
              <View style={styles.audioControlButtons}>
                <TouchableOpacity
                  style={styles.pauseAudioButton}
                  onPress={togglePauseAudio}
                >
                  <Ionicons name={isAudioPaused ? "play-circle" : "pause-circle"} size={28} color={palette.text} />
                  <Text style={styles.pauseAudioText}>{isAudioPaused ? 'Play' : 'Pause'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.stopAudioButton}
                  onPress={stopAudio}
                >
                  <Ionicons name="stop-circle" size={28} color={palette.text} />
                  <Text style={styles.stopAudioText}>Stop</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Input at bottom */}
          <View style={styles.bottomInputContainer}>
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

              <TouchableOpacity
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
              </TouchableOpacity>

              {inputText.trim().length > 0 && (
                <TouchableOpacity
                  style={[
                    styles.iconButton,
                    isLoading && styles.iconButtonDisabled,
                  ]}
                  onPress={sendTextMessage}
                  disabled={isLoading || isRecording}
                >
                  <Ionicons name="send" size={20} color={palette.buttonText} />
                </TouchableOpacity>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}
