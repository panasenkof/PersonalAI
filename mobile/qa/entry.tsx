// Production screens and job owner; only native services/navigation are fixtures.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Pressable, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Navigation } from "./navigation";
import { useTheme } from "../src/theme";
import { AppLock } from "../src/security/AppLock";
import { DirectChatProvider } from "../src/direct-agent/ChatContext";
import { HomeScreen } from "../src/screens/HomeScreen";
import { LocalMemoryScreen } from "../src/screens/LocalMemoryScreen";
import { DirectAgentSettingsScreen } from "../src/screens/DirectAgentSettingsScreen";
import { MemoryImportScreen } from "../src/screens/MemoryImportScreen";
import { MemoryNoteScreen } from "../src/screens/MemoryNoteScreen";
import { MemoryBackupScreen } from "../src/screens/MemoryBackupScreen";
import { DeviceSettingsScreen } from "../src/screens/DeviceSettingsScreen";
const screens: any = { Home: HomeScreen, LocalMemory: LocalMemoryScreen, Settings: DeviceSettingsScreen, ModelConnections: DirectAgentSettingsScreen, MemoryImport: MemoryImportScreen, MemoryNote: MemoryNoteScreen, MemoryBackup: MemoryBackupScreen };
function Screens() {
  const t = useTheme();
  const [stack, setStack] = useState<any[]>([{ name: "Home" }]);
  const route = stack.at(-1); const Screen = screens[route.name];
  const nav = { params: route.params, navigate(name: string, params?: any) { setStack(s => [ ...s, { name, params } ]); }, goBack() { setStack(s => s.length > 1 ? s.slice(0, -1) : s); }, dispatch() {}, setOptions() {} };
  return <Navigation.Provider value={nav}><View style={{ flex: 1 }}>
    {route.name !== "Home" ? <View style={{ backgroundColor: t.panel, padding: 13, paddingTop: 30, minHeight: 66, borderBottomWidth: 1, borderColor: t.line, flexDirection: "row", gap: 15 }}>
      {stack.length > 1 ? <Pressable accessibilityRole="button" accessibilityLabel="Назад" onPress={() => nav.goBack()} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: t.accent }}>←</Text></Pressable> : null}<Text style={{ fontWeight: "700", color: t.text }}>PersAI</Text>
    </View> : null}
    <Screen key={stack.length + route.name} />
    {stack.length === 1 ? <View style={{ backgroundColor: t.panel, borderTopWidth: 1, borderColor: t.line, padding: 8, paddingBottom: 32, flexDirection: "row", justifyContent: "space-around" }}>
      {[ ["Home", "Главная"], ["LocalMemory", "Память"], ["Settings", "Настройки"] ].map(([name, label]) => <Pressable key={name} accessibilityRole="button" accessibilityLabel={"Вкладка " + label} style={{ flex: 1, minWidth: 0, padding: 7, minHeight: 44, justifyContent: "center" }} onPress={() => setStack([{ name }])}><Text style={{ color: route.name === name ? t.accent : t.muted, fontSize: 11, textAlign: "center" }}>{label}</Text></Pressable>)}
    </View> : null}
  </View></Navigation.Provider>;
}
createRoot(document.getElementById("root")!).render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 24, bottom: 24, left: 0, right: 0 } }}><AppLock><DirectChatProvider><Screens /></DirectChatProvider></AppLock></SafeAreaProvider>);
