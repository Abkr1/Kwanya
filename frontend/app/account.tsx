import React, { useState, useMemo, useCallback } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { useAuth } from './_contexts/AuthContext';
import { useTheme } from './_contexts/ThemeContext';

export default function AccountScreen() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, isAuthenticated, signOut, updateProfile } = useAuth();

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(user?.display_name || '');
  const [isSaving, setIsSaving] = useState(false);

  // Reset editing state when navigating away and back
  useFocusEffect(
    useCallback(() => {
      return () => {
        setIsEditing(false);
        setEditName(user?.display_name || '');
      };
    }, [user?.display_name]),
  );

  const handleSignOut = () => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            await signOut();
            router.replace('/auth/signin');
          },
        },
      ],
    );
  };

  const handleSaveProfile = async () => {
    if (!editName.trim()) {
      Alert.alert('Error', 'Display name cannot be empty');
      return;
    }

    setIsSaving(true);
    const result = await updateProfile(editName.trim());
    setIsSaving(false);

    if (result.success) {
      setIsEditing(false);
      Alert.alert('Success', 'Profile updated');
    } else {
      Alert.alert('Error', result.error || 'Failed to update profile');
    }
  };

  const providerIcon = (provider: string) => {
    switch (provider) {
      case 'phone': return 'call-outline' as const;
      case 'email': return 'mail-outline' as const;
      case 'google': return 'logo-google' as const;
      default: return 'person-outline' as const;
    }
  };

  const providerLabel = (provider: string) => {
    switch (provider) {
      case 'phone': return 'Phone Number';
      case 'email': return 'Email';
      case 'google': return 'Google';
      default: return 'Unknown';
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
    scrollContent: {
      flex: 1,
    },
    profileSection: {
      alignItems: 'center',
      paddingVertical: 32,
      borderBottomWidth: 1,
      borderBottomColor: palette.border,
    },
    avatar: {
      width: 88,
      height: 88,
      borderRadius: 44,
      backgroundColor: palette.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 16,
      borderWidth: 2,
      borderColor: palette.border,
    },
    avatarText: {
      fontSize: 36,
      fontWeight: '700',
      color: palette.text,
    },
    displayName: {
      fontSize: 22,
      fontWeight: '700',
      color: palette.text,
      marginBottom: 4,
    },
    providerBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: palette.surfaceAlt,
      borderRadius: 20,
      paddingHorizontal: 12,
      paddingVertical: 6,
      marginTop: 8,
    },
    providerText: {
      fontSize: 13,
      color: palette.textSubtle,
      marginLeft: 6,
    },
    infoSection: {
      paddingHorizontal: 20,
      paddingTop: 24,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: palette.textSubtle,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      marginBottom: 12,
      paddingHorizontal: 4,
    },
    infoCard: {
      backgroundColor: palette.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: palette.border,
      overflow: 'hidden',
    },
    infoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    infoRowBorder: {
      borderBottomWidth: 1,
      borderBottomColor: palette.border,
    },
    infoIcon: {
      marginRight: 12,
    },
    infoContent: {
      flex: 1,
    },
    infoLabel: {
      fontSize: 12,
      color: palette.textSubtle,
      marginBottom: 2,
    },
    infoValue: {
      fontSize: 15,
      color: palette.text,
      fontWeight: '500',
    },
    verifiedBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: palette.surfaceAlt,
      borderRadius: 12,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    verifiedText: {
      fontSize: 11,
      color: palette.success,
      marginLeft: 3,
      fontWeight: '600',
    },
    unverifiedText: {
      fontSize: 11,
      color: palette.textSubtle,
      marginLeft: 3,
    },
    editSection: {
      paddingHorizontal: 20,
      paddingTop: 24,
    },
    editCard: {
      backgroundColor: palette.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: palette.border,
      padding: 16,
    },
    editLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textMuted,
      marginBottom: 8,
    },
    editInput: {
      backgroundColor: palette.bg,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 16,
      color: palette.text,
      marginBottom: 12,
    },
    editButtons: {
      flexDirection: 'row',
      gap: 10,
    },
    saveButton: {
      flex: 1,
      backgroundColor: palette.button,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
    },
    saveButtonText: {
      fontSize: 14,
      fontWeight: '700',
      color: palette.buttonText,
    },
    cancelButton: {
      flex: 1,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: palette.border,
    },
    cancelButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textMuted,
    },
    actionsSection: {
      paddingHorizontal: 20,
      paddingTop: 24,
      paddingBottom: 40,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: palette.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: 16,
      paddingVertical: 14,
      marginBottom: 10,
    },
    actionButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: palette.text,
      marginLeft: 12,
      flex: 1,
    },
    signoutButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.dangerBg,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: palette.danger,
      paddingVertical: 14,
      marginTop: 8,
    },
    signoutButtonText: {
      fontSize: 15,
      fontWeight: '700',
      color: palette.danger,
      marginLeft: 8,
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
  }), [palette, insets]);

  // If not authenticated, show sign-in prompt
  if (!isAuthenticated || !user) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={() => router.replace({ pathname: '/', params: { sidebar: '1' } })}>
            <Ionicons name="arrow-back" size={24} color={palette.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Account</Text>
        </View>

        <View style={styles.centeredContent}>
          <View style={styles.iconCircle}>
            <Ionicons name="person-outline" size={48} color={palette.textSubtle} />
          </View>
          <Text style={styles.noAuthTitle}>No Account</Text>
          <Text style={styles.noAuthSubtitle}>
            Sign in or create an account to manage your profile
          </Text>

          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => router.push('/auth/signup')}
          >
            <Text style={styles.primaryButtonText}>Sign Up</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => router.push('/auth/signin')}
          >
            <Text style={styles.secondaryButtonText}>Sign In</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const initials = (user.display_name || user.email || '?')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.replace({ pathname: '/', params: { sidebar: '1' } })}>
          <Ionicons name="arrow-back" size={24} color={palette.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Account</Text>
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
        {/* Profile Header */}
        <View style={styles.profileSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <Text style={styles.displayName}>{user.display_name || 'User'}</Text>
          <View style={styles.providerBadge}>
            <Ionicons name={providerIcon(user.auth_provider)} size={14} color={palette.textSubtle} />
            <Text style={styles.providerText}>Signed in with {providerLabel(user.auth_provider)}</Text>
          </View>
        </View>

        {/* Account Info */}
        <View style={styles.infoSection}>
          <Text style={styles.sectionTitle}>Account Information</Text>
          <View style={styles.infoCard}>
            {/* Phone - only for phone users */}
            {user.auth_provider === 'phone' && user.phone && (
              <View style={[styles.infoRow, styles.infoRowBorder]}>
                <Ionicons name="call-outline" size={20} color={palette.textSubtle} style={styles.infoIcon} />
                <View style={styles.infoContent}>
                  <Text style={styles.infoLabel}>Phone</Text>
                  <Text style={styles.infoValue}>{user.phone}</Text>
                </View>
                <View style={styles.verifiedBadge}>
                  <Ionicons
                    name={user.is_phone_verified ? 'checkmark-circle' : 'alert-circle-outline'}
                    size={14}
                    color={user.is_phone_verified ? palette.success : palette.textSubtle}
                  />
                  <Text style={user.is_phone_verified ? styles.verifiedText : styles.unverifiedText}>
                    {user.is_phone_verified ? 'Verified' : 'Unverified'}
                  </Text>
                </View>
              </View>
            )}

            {/* Email - only for email users */}
            {user.auth_provider === 'email' && (
              <View style={[styles.infoRow, styles.infoRowBorder]}>
                <Ionicons name="mail-outline" size={20} color={palette.textSubtle} style={styles.infoIcon} />
                <View style={styles.infoContent}>
                  <Text style={styles.infoLabel}>Email</Text>
                  <Text style={styles.infoValue}>{user.email}</Text>
                </View>
                <View style={styles.verifiedBadge}>
                  <Ionicons
                    name={user.is_email_verified ? 'checkmark-circle' : 'alert-circle-outline'}
                    size={14}
                    color={user.is_email_verified ? palette.success : palette.textSubtle}
                  />
                  <Text style={user.is_email_verified ? styles.verifiedText : styles.unverifiedText}>
                    {user.is_email_verified ? 'Verified' : 'Unverified'}
                  </Text>
                </View>
              </View>
            )}

            {/* Email - for google users (always verified) */}
            {user.auth_provider === 'google' && (
              <View style={[styles.infoRow, styles.infoRowBorder]}>
                <Ionicons name="mail-outline" size={20} color={palette.textSubtle} style={styles.infoIcon} />
                <View style={styles.infoContent}>
                  <Text style={styles.infoLabel}>Email</Text>
                  <Text style={styles.infoValue}>{user.email}</Text>
                </View>
                <View style={styles.verifiedBadge}>
                  <Ionicons name="checkmark-circle" size={14} color={palette.success} />
                  <Text style={styles.verifiedText}>Verified</Text>
                </View>
              </View>
            )}

            {/* Auth Provider */}
            <View style={styles.infoRow}>
              <Ionicons name={providerIcon(user.auth_provider)} size={20} color={palette.textSubtle} style={styles.infoIcon} />
              <View style={styles.infoContent}>
                <Text style={styles.infoLabel}>Sign-in Method</Text>
                <Text style={styles.infoValue}>{providerLabel(user.auth_provider)}</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Edit Profile */}
        <View style={styles.editSection}>
          <Text style={styles.sectionTitle}>Edit Profile</Text>
          {isEditing ? (
            <View style={styles.editCard}>
              <Text style={styles.editLabel}>Display Name</Text>
              <TextInput
                style={styles.editInput}
                value={editName}
                onChangeText={setEditName}
                placeholder="Your name"
                placeholderTextColor={palette.textSubtle}
                autoFocus
              />
              <View style={styles.editButtons}>
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={() => {
                    setIsEditing(false);
                    setEditName(user.display_name || '');
                  }}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveButton} onPress={handleSaveProfile} disabled={isSaving}>
                  {isSaving ? (
                    <ActivityIndicator size="small" color={palette.buttonText} />
                  ) : (
                    <Text style={styles.saveButtonText}>Save</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => {
                setEditName(user.display_name || '');
                setIsEditing(true);
              }}
            >
              <Ionicons name="create-outline" size={20} color={palette.textSubtle} />
              <Text style={styles.actionButtonText}>Edit Display Name</Text>
              <Ionicons name="chevron-forward" size={18} color={palette.textSubtle} />
            </TouchableOpacity>
          )}
        </View>

        {/* Actions */}
        <View style={styles.actionsSection}>
          <Text style={styles.sectionTitle}>Actions</Text>

          {/* Verify phone - only for phone users */}
          {user.auth_provider === 'phone' && !user.is_phone_verified && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => router.push({ pathname: '/auth/verify-phone', params: { phone: user.phone! } })}
            >
              <Ionicons name="shield-checkmark-outline" size={20} color={palette.textSubtle} />
              <Text style={styles.actionButtonText}>Verify Phone Number</Text>
              <Ionicons name="chevron-forward" size={18} color={palette.textSubtle} />
            </TouchableOpacity>
          )}

          {/* Verify email - only for email users */}
          {user.auth_provider === 'email' && !user.is_email_verified && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => router.push({ pathname: '/auth/verify-email', params: { email: user.email } })}
            >
              <Ionicons name="shield-checkmark-outline" size={20} color={palette.textSubtle} />
              <Text style={styles.actionButtonText}>Verify Email Address</Text>
              <Ionicons name="chevron-forward" size={18} color={palette.textSubtle} />
            </TouchableOpacity>
          )}

          {/* Sign Out */}
          <TouchableOpacity style={styles.signoutButton} onPress={handleSignOut}>
            <Ionicons name="log-out-outline" size={20} color={palette.danger} />
            <Text style={styles.signoutButtonText}>Sign Out</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
