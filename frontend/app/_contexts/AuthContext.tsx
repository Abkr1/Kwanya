import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8001';
const AUTH_TOKEN_KEY = 'kwanya_auth_token';
const AUTH_USER_KEY = 'kwanya_auth_user';

export interface AuthUser {
  id: string;
  phone?: string | null;
  email: string;
  display_name?: string | null;
  auth_provider: string;
  is_phone_verified?: boolean;
  is_email_verified?: boolean;
  created_at?: string;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  signUpWithPhone: (phone: string, password: string, displayName?: string) => Promise<{ success: boolean; error?: string }>;
  signUpWithEmail: (email: string, password: string, displayName?: string) => Promise<{ success: boolean; error?: string }>;
  signUpWithGoogle: (googleToken: string, displayName?: string) => Promise<{ success: boolean; error?: string }>;
  signIn: (identifier: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signInWithGoogle: (googleToken: string) => Promise<{ success: boolean; error?: string }>;
  signOut: () => Promise<void>;
  verifyOTP: (phone: string, otp: string) => Promise<{ success: boolean; error?: string }>;
  verifyEmail: (email: string, code: string) => Promise<{ success: boolean; error?: string }>;
  resendOTP: (phone: string) => Promise<{ success: boolean; error?: string }>;
  resendEmailCode: (email: string) => Promise<{ success: boolean; error?: string }>;
  updateProfile: (displayName: string) => Promise<{ success: boolean; error?: string }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isAuthenticated = !!user && !!token;

  // Load stored auth on mount
  useEffect(() => {
    const loadAuth = async () => {
      try {
        const [storedToken, storedUser] = await Promise.all([
          AsyncStorage.getItem(AUTH_TOKEN_KEY),
          AsyncStorage.getItem(AUTH_USER_KEY),
        ]);

        if (storedToken && storedUser) {
          // Verify token is still valid
          try {
            const response = await axios.get(`${BACKEND_URL}/api/auth/me`, {
              headers: { Authorization: `Bearer ${storedToken}` },
            });
            if (response.data.success) {
              setToken(storedToken);
              setUser(response.data.user);
            } else {
              await clearAuth();
            }
          } catch {
            // Token expired or invalid - clear stored auth
            await clearAuth();
          }
        }
      } catch (error) {
        console.error('Failed to load auth:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadAuth();
  }, []);

  const saveAuth = async (newToken: string, newUser: AuthUser) => {
    setToken(newToken);
    setUser(newUser);
    await Promise.all([
      AsyncStorage.setItem(AUTH_TOKEN_KEY, newToken),
      AsyncStorage.setItem(AUTH_USER_KEY, JSON.stringify(newUser)),
    ]);
  };

  const clearAuth = async () => {
    setToken(null);
    setUser(null);
    await Promise.all([
      AsyncStorage.removeItem(AUTH_TOKEN_KEY),
      AsyncStorage.removeItem(AUTH_USER_KEY),
    ]);
  };

  const signUpWithPhone = useCallback(async (phone: string, password: string, displayName?: string) => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/auth/signup/phone`, {
        phone,
        password,
        display_name: displayName,
      });
      if (response.data.success) {
        await saveAuth(response.data.token, response.data.user);
        return { success: true };
      }
      return { success: false, error: 'Signup failed' };
    } catch (error: any) {
      const msg = error.response?.data?.detail || 'Signup failed';
      return { success: false, error: msg };
    }
  }, []);

  const signUpWithEmail = useCallback(async (email: string, password: string, displayName?: string) => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/auth/signup/email`, {
        email,
        password,
        display_name: displayName,
      });
      if (response.data.success) {
        await saveAuth(response.data.token, response.data.user);
        return { success: true };
      }
      return { success: false, error: 'Signup failed' };
    } catch (error: any) {
      const msg = error.response?.data?.detail || 'Signup failed';
      return { success: false, error: msg };
    }
  }, []);

  const signUpWithGoogle = useCallback(async (googleToken: string, displayName?: string) => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/auth/signup/google`, {
        google_token: googleToken,
        display_name: displayName,
      });
      if (response.data.success) {
        await saveAuth(response.data.token, response.data.user);
        return { success: true };
      }
      return { success: false, error: 'Signup failed' };
    } catch (error: any) {
      const msg = error.response?.data?.detail || 'Signup failed';
      return { success: false, error: msg };
    }
  }, []);

  const signIn = useCallback(async (identifier: string, password: string) => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/auth/signin`, {
        identifier,
        password,
      });
      if (response.data.success) {
        await saveAuth(response.data.token, response.data.user);
        return { success: true };
      }
      return { success: false, error: 'Sign in failed' };
    } catch (error: any) {
      const msg = error.response?.data?.detail || 'Invalid credentials';
      return { success: false, error: msg };
    }
  }, []);

  const signInWithGoogle = useCallback(async (googleToken: string) => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/auth/signin/google`, {
        google_token: googleToken,
      });
      if (response.data.success) {
        await saveAuth(response.data.token, response.data.user);
        return { success: true };
      }
      return { success: false, error: 'Sign in failed' };
    } catch (error: any) {
      const msg = error.response?.data?.detail || 'Google sign in failed';
      return { success: false, error: msg };
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await axios.post(`${BACKEND_URL}/api/auth/signout`);
    } catch {
      // Ignore signout API errors
    }
    await clearAuth();
  }, []);

  const verifyOTP = useCallback(async (phone: string, otp: string) => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/auth/verify-otp`, {
        phone,
        otp,
      });
      if (response.data.success) {
        // Update local user state
        if (user) {
          const updatedUser = { ...user, is_phone_verified: true };
          setUser(updatedUser);
          await AsyncStorage.setItem(AUTH_USER_KEY, JSON.stringify(updatedUser));
        }
        return { success: true };
      }
      return { success: false, error: 'Verification failed' };
    } catch (error: any) {
      const msg = error.response?.data?.detail || 'Invalid OTP';
      return { success: false, error: msg };
    }
  }, [user]);

  const verifyEmail = useCallback(async (email: string, code: string) => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/auth/verify-email`, {
        email,
        code,
      });
      if (response.data.success) {
        if (user) {
          const updatedUser = { ...user, is_email_verified: true };
          setUser(updatedUser);
          await AsyncStorage.setItem(AUTH_USER_KEY, JSON.stringify(updatedUser));
        }
        return { success: true };
      }
      return { success: false, error: 'Verification failed' };
    } catch (error: any) {
      const msg = error.response?.data?.detail || 'Invalid code';
      return { success: false, error: msg };
    }
  }, [user]);

  const resendOTP = useCallback(async (phone: string) => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/auth/resend-otp`, { phone });
      if (response.data.success) return { success: true };
      return { success: false, error: 'Failed to resend' };
    } catch (error: any) {
      const msg = error.response?.data?.detail || 'Failed to resend OTP';
      return { success: false, error: msg };
    }
  }, []);

  const resendEmailCode = useCallback(async (email: string) => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/auth/resend-email-code`, { email });
      if (response.data.success) return { success: true };
      return { success: false, error: 'Failed to resend' };
    } catch (error: any) {
      const msg = error.response?.data?.detail || 'Failed to resend code';
      return { success: false, error: msg };
    }
  }, []);

  const updateProfile = useCallback(async (displayName: string) => {
    try {
      const response = await axios.patch(
        `${BACKEND_URL}/api/auth/profile`,
        { display_name: displayName },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (response.data.success && user) {
        const updatedUser = { ...user, display_name: displayName };
        setUser(updatedUser);
        await AsyncStorage.setItem(AUTH_USER_KEY, JSON.stringify(updatedUser));
        return { success: true };
      }
      return { success: false, error: 'Update failed' };
    } catch (error: any) {
      const msg = error.response?.data?.detail || 'Update failed';
      return { success: false, error: msg };
    }
  }, [token, user]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        isAuthenticated,
        signUpWithPhone,
        signUpWithEmail,
        signUpWithGoogle,
        signIn,
        signInWithGoogle,
        signOut,
        verifyOTP,
        verifyEmail,
        resendOTP,
        resendEmailCode,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
