import Feather from "@expo/vector-icons/Feather";
import type { NavigatorScreenParams } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";
import { ActivityIndicator, Text, useColorScheme, View } from "react-native";

import { useAuth } from "./auth/AuthContext";
import { ChatScreen } from "./screens/ChatScreen";
import { DirectAgentScreen } from "./screens/DirectAgentScreen";
import { DirectAgentSettingsScreen } from "./screens/DirectAgentSettingsScreen";
import { ChatsScreen } from "./screens/ChatsScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { MemoryImportScreen } from "./screens/MemoryImportScreen";
import { LocalMemoryScreen } from "./screens/LocalMemoryScreen";
import { DeviceSettingsScreen } from "./screens/DeviceSettingsScreen";
import { LocalHomeScreen } from "./screens/LocalHomeScreen";
import { useTheme } from "./theme";

export type TabParams = { ChatsTab: undefined; DirectAgent: { initialPrompt?: string } | undefined; LocalMemory: undefined; Settings: undefined };
export type RootStackParams = {
  Tabs: NavigatorScreenParams<TabParams> | undefined;
  Chat: { conversationId?: string; title?: string; initialPrompt?: string };
  DirectAgentSettings: undefined;
  MemoryImport: undefined;
};
const Stack = createNativeStackNavigator<RootStackParams>();
const Tab = createBottomTabNavigator<TabParams>();

function Tabs() {
  const { offlineMode } = useAuth();
  const t = useTheme();
  const tabIcon = (symbol: React.ComponentProps<typeof Feather>["name"]) => ({ color }: { color: string }) => (
    <Feather name={symbol} color={color} size={22} />
  );
  return (
    <Tab.Navigator screenOptions={{
      tabBarActiveTintColor: t.accent,
      tabBarInactiveTintColor: t.muted,
      tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      tabBarStyle: { backgroundColor: t.panel, borderTopColor: t.line, minHeight: 64, paddingTop: 7, elevation: 0 },
      headerStyle: { backgroundColor: t.panel },
      headerTintColor: t.text,
    }}>
      <Tab.Screen name="ChatsTab" component={offlineMode ? LocalHomeScreen : ChatsScreen}
          options={{ title: "Главная", tabBarIcon: tabIcon("home") }} />
      <Tab.Screen name="DirectAgent" component={DirectAgentScreen}
        options={{ title: "Ассистент", tabBarIcon: tabIcon("message-circle") }} />
      <Tab.Screen name="LocalMemory" component={LocalMemoryScreen}
        options={{ title: "Локальная память", tabBarLabel: "Память", tabBarIcon: tabIcon("database") }} />
      <Tab.Screen name="Settings" component={DeviceSettingsScreen}
          options={{ title: "Настройки", tabBarIcon: tabIcon("settings") }} />
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
        <Stack.Screen name="DirectAgentSettings" component={DirectAgentSettingsScreen}
          options={{ title: "Подключение ИИ" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
