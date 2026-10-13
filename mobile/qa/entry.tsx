// Browser interaction fixture renders production screens. Native services and
// storage are simulated; this is never bundled into the shipped app.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Pressable, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Navigation } from "./navigation";
import { useTheme } from "../src/theme";
import { AppLock } from "../src/security/AppLock";
import { LocalHomeScreen } from "../src/screens/LocalHomeScreen";
import { LocalMemoryScreen } from "../src/screens/LocalMemoryScreen";
import { DirectAgentScreen } from "../src/screens/DirectAgentScreen";
import { DirectAgentSettingsScreen } from "../src/screens/DirectAgentSettingsScreen";
import { MemoryImportScreen } from "../src/screens/MemoryImportScreen";
import { DeviceSettingsScreen } from "../src/screens/DeviceSettingsScreen";
const screens: any = { ChatsTab: LocalHomeScreen, DirectAgent: DirectAgentScreen, LocalMemory: LocalMemoryScreen, Settings: DeviceSettingsScreen, DirectAgentSettings: DirectAgentSettingsScreen, MemoryImport: MemoryImportScreen };
function Screens() {
  const t = useTheme();
  const [stack, setStack] = useState<any[]>([{ name: "ChatsTab" }]);
  const route = stack.at(-1); const Screen = screens[route.name];
  const nav = { params: route.params, navigate(name: string, params?: any) { setStack(s => [ ...s, { name, params } ]); }, goBack() { setStack(s => s.length > 1 ? s.slice(0, -1) : s); } };
  return <Navigation.Provider value={nav}><View style={{ flex: 1 }}>
    <View style={{ backgroundColor: t.panel, padding: 13, minHeight: 50, borderBottomWidth: 1, borderColor: t.line, flexDirection: "row", gap: 15 }}>
      {stack.length > 1 ? <Pressable accessibilityRole="button" accessibilityLabel="Назад" onPress={() => nav.goBack()}><Text style={{ color: t.accent }}>←</Text></Pressable> : null}<Text style={{ fontWeight: "700", color: t.text }}>PersAI</Text>
    </View>
    <Screen key={stack.length + route.name} />
    <View style={{ backgroundColor: t.panel, borderTopWidth: 1, borderColor: t.line, padding: 8, flexDirection: "row", justifyContent: "space-around" }}>
      {[ ["ChatsTab", "Главная"], ["DirectAgent", "Ассистент"], ["LocalMemory", "Память"], ["Settings", "Настройки"] ].map(([name, label]) => <Pressable key={name} accessibilityRole="button" accessibilityLabel={"Вкладка " + label} style={{ flex: 1, minWidth: 0, padding: 7, minHeight: 44, justifyContent: "center" }} onPress={() => setStack([{ name }])}><Text style={{ color: route.name === name ? t.accent : t.muted, fontSize: 11, textAlign: "center" }}>{label}</Text></Pressable>)}
    </View>
  </View></Navigation.Provider>;
}
createRoot(document.getElementById("root")!).render(<SafeAreaProvider><AppLock><Screens /></AppLock></SafeAreaProvider>);
