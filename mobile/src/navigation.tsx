import Feather from "@expo/vector-icons/Feather";
import type { NavigatorScreenParams } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";
import { ActivityIndicator, Text, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "./auth/AuthContext";
import { ChatScreen } from "./screens/ChatScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { DirectAgentSettingsScreen } from "./screens/DirectAgentSettingsScreen";
import { ChatsScreen } from "./screens/ChatsScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { MemoryImportScreen } from "./screens/MemoryImportScreen";
import { LocalMemoryScreen } from "./screens/LocalMemoryScreen";
import { MemoryNoteScreen } from "./screens/MemoryNoteScreen";
import { MemoryBackupScreen } from "./screens/MemoryBackupScreen";
import { DeviceSettingsScreen } from "./screens/DeviceSettingsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { useTheme } from "./theme";

export type TabParams = { Home: undefined; LocalMemory: undefined; Settings: undefined };
export type RootStackParams = {
  Tabs: NavigatorScreenParams<TabParams> | undefined;
  Chat: { conversationId?: string; title?: string; initialPrompt?: string };
  ModelConnections: undefined;
  ServerSettings: undefined;
  ServerChats: undefined;
  MemoryNote: { entityId?: string; collectionId?: string };
  MemoryBackup: undefined;
  MemoryImport: undefined;
};
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
  const { ready, me, offlineMode } = useAuth();
  const dark = useColorScheme() === "dark";
  const t = useTheme();
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!me && !offlineMode) return <LoginScreen />;
  return (
    <NavigationContainer theme={dark ? DarkTheme : DefaultTheme}>
      <Stack.Navigator screenOptions={{
        headerStyle: { backgroundColor: t.panel }, headerTintColor: t.text,
      }}>
        <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
        <Stack.Screen name="Chat" component={ChatScreen} options={{ title: "Чат" }} />
        <Stack.Screen name="MemoryImport" component={MemoryImportScreen} options={{ title: "Добавить в память" }} />
        <Stack.Screen name="MemoryNote" component={MemoryNoteScreen} options={{ title: "Запись" }} />
        <Stack.Screen name="MemoryBackup" component={MemoryBackupScreen} options={{ title: "Резервные копии" }} />
        <Stack.Screen name="ModelConnections" component={DirectAgentSettingsScreen} options={{ title: "Модели и подключения" }} />
        <Stack.Screen name="ServerSettings" component={SettingsScreen} options={{ title: "Серверный аккаунт" }} />
        <Stack.Screen name="ServerChats" component={ChatsScreen} options={{ title: "Серверные диалоги" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
