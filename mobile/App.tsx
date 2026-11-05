import { StatusBar } from "expo-status-bar";
import React from "react";
import { View } from "react-native";
import { initialWindowMetrics, SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { ProfileProvider } from "./src/profile/ProfileContext";
import { AppLock } from "./src/security/AppLock";
import { RootNavigator } from "./src/navigation";
import { DirectChatProvider } from "./src/direct-agent/ChatContext";
import { nebulaPalette } from "./src/design/nebula/tokens";

/** Android 15+ draws the app behind the system bars and the three-button
 * navigation bar keeps its own light scrim. The app owns that strip now: this
 * dark scrim sits underneath the buttons so page text never shows through a
 * white band. */
function SystemBarScrim() {
  const insets = useSafeAreaInsets();
  if (insets.bottom <= 0) return null;
  return <View pointerEvents="none" style={{
    position: "absolute", left: 0, right: 0, bottom: 0, height: insets.bottom,
    backgroundColor: nebulaPalette.dark.canvas,
  }} />;
}

export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <AppLock>
        <ProfileProvider>
          <DirectChatProvider>
            <StatusBar style="light" />
            <RootNavigator />
            <SystemBarScrim />
          </DirectChatProvider>
        </ProfileProvider>
      </AppLock>
    </SafeAreaProvider>
  );
}
