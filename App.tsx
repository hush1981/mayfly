import 'react-native-get-random-values';
import React from 'react';
import { AppRegistry } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/store/AuthProvider';
import Navigation from './src/navigation';
import { DialogHost } from './src/ui/dialog';
import pushTask from './src/notifications/pushTask';
import { isLightTheme } from './src/theme';
// calls: registers the signal handler (also in the headless push task) and the notification actions
import './src/calls/manager';

// Push while the app is not running: sync + notify (skips muted chats).
AppRegistry.registerHeadlessTask('MayflyPushTask', () => pushTask);

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style={isLightTheme ? 'dark' : 'light'} />
        <Navigation />
        <DialogHost />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
