import { StatusBar } from "expo-status-bar";
import React from "react";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";

import { AuthProvider } from "./src/auth/AuthContext";
import { AppLock } from "./src/security/AppLock";
import { RootNavigator } from "./src/navigation";
import { DirectChatProvider } from "./src/direct-agent/ChatContext";

export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <AppLock>
        <AuthProvider>
          <DirectChatProvider>
            <StatusBar style="auto" />
            <RootNavigator />
          </DirectChatProvider>
        </AuthProvider>
      </AppLock>
    </SafeAreaProvider>
  );
}
