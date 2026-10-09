import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";
import { ActivityIndicator, Text, useColorScheme, View } from "react-native";

import { useAuth } from "./auth/AuthContext";
import { ChatScreen } from "./screens/ChatScreen";
import { ChatsScreen } from "./screens/ChatsScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { LocalMemoryScreen } from "./screens/LocalMemoryScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export type RootStackParams = {
  Tabs: undefined;
  Chat: { conversationId?: string; title?: string };
};

const Stack = createNativeStackNavigator<RootStackParams>();
const Tab = createBottomTabNavigator();

function Tabs() {
  const { offlineMode } = useAuth();
  return (
    <Tab.Navigator>
      {!offlineMode && <Tab.Screen
        name="ChatsTab"
        component={ChatsScreen}
        options={{ title: "Чаты", tabBarIcon: () => <Text>💬</Text> }}
      />}
      <Tab.Screen name="LocalMemory" component={LocalMemoryScreen}
        options={{ title: "На телефоне", tabBarIcon: () => <Text>🔐</Text> }} />
      {!offlineMode && <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: "Настройки", tabBarIcon: () => <Text>⚙️</Text> }} />}
    </Tab.Navigator>
  );
}

export function RootNavigator() {
  const { ready, me, offlineMode } = useAuth();
  const dark = useColorScheme() === "dark";
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
      <Stack.Navigator>
        <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
        <Stack.Screen name="Chat" component={ChatScreen} options={{ title: "Чат" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
