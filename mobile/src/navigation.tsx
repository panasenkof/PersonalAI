import Feather from "@expo/vector-icons/Feather";
import type { SharePayload } from "expo-sharing";
import { StackActions } from "@react-navigation/native";
import type { NavigatorScreenParams } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React, { useEffect } from "react";
import { createNavigationContainerRef } from "@react-navigation/native";
import { IncomingShares } from "./media/IncomingShares";
import { clearAttachmentPreviews } from "./media/attachments";
import { useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HomeScreen } from "./screens/HomeScreen";
import { DirectAgentSettingsScreen } from "./screens/DirectAgentSettingsScreen";
import { MemoryImportScreen } from "./screens/MemoryImportScreen";
import { LocalMemoryScreen } from "./screens/LocalMemoryScreen";
import { MemoryNoteScreen } from "./screens/MemoryNoteScreen";
import { MemoryBackupScreen } from "./screens/MemoryBackupScreen";
import { DeviceSettingsScreen } from "./screens/DeviceSettingsScreen";
import { DiagnosticLogsScreen } from "./screens/DiagnosticLogsScreen";
import { useTheme } from "./theme";

export type TabParams = { Home: undefined; LocalMemory: undefined; Settings: undefined };
export type RootStackParams = {
  Tabs: NavigatorScreenParams<TabParams> | undefined;
  /** `presetId` adds and selects a ready-made provider (first-run setup). */
  ModelConnections: { presetId?: string } | undefined;
  MemoryNote: { entityId?: string; collectionId?: string };
  MemoryBackup: undefined;
  MemoryImport: { incoming?: SharePayload[]; camera?: boolean } | undefined;
  DiagnosticLogs: undefined;
  /** Research-only native graphics screen (not a bottom tab). */
  NebulaLab: undefined;
};
const navigationRef = createNavigationContainerRef<RootStackParams>();
const Stack = createNativeStackNavigator<RootStackParams>();
const Tab = createBottomTabNavigator<TabParams>();

function Tabs() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const tabIcon = (symbol: React.ComponentProps<typeof Feather>["name"]) => ({ color }: { color: string }) => (
    <Feather name={symbol} color={color} size={22} />
  );
  return (
    <Tab.Navigator screenOptions={{
      tabBarActiveTintColor: t.accent,
      tabBarInactiveTintColor: t.muted,
      tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      // Navigation measures height, not minHeight: reserve the control row
      // PLUS the system bar so both the buttons and the scene clear it.
      tabBarStyle: { height: 64 + insets.bottom, paddingTop: 7, paddingBottom: insets.bottom + 7,
        backgroundColor: t.panel, borderTopColor: t.line, elevation: 0 },
      headerStyle: { backgroundColor: t.panel },
      headerTintColor: t.text,
      tabBarHideOnKeyboard: true,
    }}>
      <Tab.Screen name="Home" component={HomeScreen}
          options={{ title: "Главная", headerShown: false, tabBarAccessibilityLabel: "Вкладка Главная", tabBarIcon: tabIcon("home") }} />
      <Tab.Screen name="LocalMemory" component={LocalMemoryScreen}
        options={{ title: "Память", tabBarAccessibilityLabel: "Вкладка Память", tabBarIcon: tabIcon("database") }} />
      <Tab.Screen name="Settings" component={DeviceSettingsScreen}
          options={{ title: "Настройки", tabBarAccessibilityLabel: "Вкладка Настройки", tabBarIcon: tabIcon("settings") }} />
    </Tab.Navigator>
  );
}
export function RootNavigator() {
  useEffect(() => { clearAttachmentPreviews(); }, []);
  const dark = useColorScheme() === "dark";
  const t = useTheme();
  return (
    <NavigationContainer ref={navigationRef} theme={dark ? DarkTheme : DefaultTheme}>
      <IncomingShares open={incoming => { if (!navigationRef.isReady()) return false; navigationRef.dispatch(StackActions.push("MemoryImport", { incoming })); return true; }} />
      <Stack.Navigator screenOptions={{
        headerStyle: { backgroundColor: t.panel }, headerTintColor: t.text,
      }}>
        <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
        <Stack.Screen name="MemoryImport" component={MemoryImportScreen} options={{ title: "Добавить в память" }} />
        <Stack.Screen name="MemoryNote" component={MemoryNoteScreen} options={{ title: "Запись" }} />
        <Stack.Screen name="MemoryBackup" component={MemoryBackupScreen} options={{ title: "Резервные копии" }} />
        <Stack.Screen name="ModelConnections" component={DirectAgentSettingsScreen} options={{ title: "Модели и подключения" }} />
        <Stack.Screen name="DiagnosticLogs" component={DiagnosticLogsScreen} options={{ title: "Диагностика" }} />
        {/* Lazily require the experimental native shader only when the lab is opened.
            Do not create a fourth bottom tab or initialize Skia on app launch. */}
        <Stack.Screen name="NebulaLab"
          getComponent={() => require("./design/nebula/NebulaSkiaLabScreen").NebulaSkiaLabScreen}
          options={{ title: "Лаборатория Nebula" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
