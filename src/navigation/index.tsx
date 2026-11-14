import React from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../store/AuthProvider';
import { RootStackParamList } from '../types';
import { colors, isLightTheme } from '../theme';

import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import HomeScreen from '../screens/HomeScreen';
import CameraScreen from '../screens/CameraScreen';
import SelectFriendScreen from '../screens/SelectFriendScreen';
import ViewMomentScreen from '../screens/ViewMomentScreen';
import FriendsScreen from '../screens/FriendsScreen';
import GroupsScreen from '../screens/GroupsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import ComposeScreen from '../screens/ComposeScreen';
import ChatScreen from '../screens/ChatScreen';
import VerifyScreen from '../screens/VerifyScreen';
import StoryScreen from '../screens/StoryScreen';
import StoryAudienceScreen from '../screens/StoryAudienceScreen';
import GroupInfoScreen from '../screens/GroupInfoScreen';
import NewGroupChatScreen from '../screens/NewGroupChatScreen';
import { t } from '../i18n';
import { navRef } from './ref';
import CallScreen from '../screens/CallScreen';
import { checkLaunchAction, relockUnlessOnCall } from '../calls/manager';

const Stack = createNativeStackNavigator<RootStackParamList>();

/** Camera, editor and viewer are always black, whatever the theme. */
const MEDIA = { statusBarColor: '#000000', statusBarStyle: 'light' as const, navigationBarColor: '#000000' };

export default function Navigation() {
  const { state } = useAuth();

  if (state.isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primaryText} />
      </View>
    );
  }

  return (
    <NavigationContainer
      ref={navRef}
      onReady={checkLaunchAction}
      onStateChange={() => relockUnlessOnCall(navRef.getCurrentRoute()?.name)}
    >
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.onSurface,
          headerTitleStyle: { fontWeight: '600', fontSize: 18 },
          statusBarColor: colors.background,
          statusBarStyle: isLightTheme ? 'dark' : 'light',
          navigationBarColor: colors.background,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'slide_from_right',
        }}
      >
        {state.token == null ? (
          <>
            <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Register" component={RegisterScreen} options={{ title: t('Create Account') }} />
          </>
        ) : (
          <>
            <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Chat" component={ChatScreen} options={({ route }) => ({ title: route.params.peerName })} />
            <Stack.Screen name="Verify" component={VerifyScreen} options={{ title: t('Verify') }} />
            <Stack.Screen name="Friends" component={FriendsScreen} options={{ title: t('Friends') }} />
            <Stack.Screen name="Groups" component={GroupsScreen} options={{ title: t('Broadcast lists') }} />
            <Stack.Screen name="Profile" component={ProfileScreen} options={{ title: t('Profile') }} />
            <Stack.Screen name="Story" component={StoryScreen} options={{ headerShown: false, ...MEDIA }} />
            <Stack.Screen name="StoryAudience" component={StoryAudienceScreen} options={{ title: t('Who can see my story') }} />
            <Stack.Screen name="GroupInfo" component={GroupInfoScreen} options={{ title: t('Group') }} />
            <Stack.Screen name="NewGroupChat" component={NewGroupChatScreen} options={{ title: t('New group chat') }} />
            <Stack.Screen name="Camera" component={CameraScreen} options={{ headerShown: false, ...MEDIA }} />
            <Stack.Screen name="Call" component={CallScreen} options={{ headerShown: false, gestureEnabled: false, ...MEDIA }} />
            <Stack.Screen name="Compose" component={ComposeScreen} options={{ headerShown: false, ...MEDIA }} />
            <Stack.Screen
              name="SelectFriend"
              component={SelectFriendScreen}
              options={{ title: t('Send To') }}
            />
            <Stack.Screen
              name="ViewMoment"
              component={ViewMomentScreen}
              options={{ headerShown: false, gestureEnabled: false, ...MEDIA }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
