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
import { LocalMemoryScreen } from "./screens/LocalMemoryScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { useTheme } from "./theme";

export type RootStackParams = {
  Tabs: undefined;
  Chat: { conversationId?: string; title?: string; initialPrompt?: string };
  DirectAgentSettings: undefined;
};
const Stack = createNativeStackNavigator<RootStackParams>();
const Tab = createBottomTabNavigator();

function Tabs() {
  const { offlineMode } = useAuth();
  const t = useTheme();
  const tabIcon = (symbol: string) => ({ color }: { color: string }) => (
    <Text style={{ color, fontSize: 21 }}>{symbol}</Text>
  );
  return (
    <Tab.Navigator screenOptions={{
      tabBarActiveTintColor: t.accent,
      tabBarInactiveTintColor: t.muted,
      tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      tabBarStyle: { backgroundColor: t.panel, borderTopColor: t.line, height: 64, paddingBottom: 7, elevation: 8 },
      headerStyle: { backgroundColor: t.panel },
      headerTintColor: t.text,
    }}>
      {!offlineMode && (
        <Tab.Screen name="ChatsTab" component={ChatsScreen}
          options={{ title: "Главная", tabBarIcon: tabIcon("⌂") }} />
      )}
      <Tab.Screen name="DirectAgent" component={DirectAgentScreen}
        options={{ title: "Ассистент", tabBarIcon: tabIcon("✦") }} />
      <Tab.Screen name="LocalMemory" component={LocalMemoryScreen}
        options={{ title: "Локальная память", tabBarLabel: "Память", tabBarIcon: tabIcon("◈") }} />
      {!offlineMode && (
        <Tab.Screen name="Settings" component={SettingsScreen}
          options={{ title: "Настройки", tabBarIcon: tabIcon("⚙") }} />
      )}
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
        <Stack.Screen name="DirectAgentSettings" component={DirectAgentSettingsScreen}
          options={{ title: "Подключение ИИ" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
