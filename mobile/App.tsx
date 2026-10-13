import { StatusBar } from "expo-status-bar";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AuthProvider } from "./src/auth/AuthContext";
import { AppLock } from "./src/security/AppLock";
import { RootNavigator } from "./src/navigation";

export default function App() {
  return (
    <SafeAreaProvider>
      <AppLock>
      <AuthProvider>
        <StatusBar style="auto" />
        <RootNavigator />
      </AuthProvider>
      </AppLock>
    </SafeAreaProvider>
  );
}
