import { useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import Feather from "@expo/vector-icons/Feather";
import { LinearGradient } from "expo-linear-gradient";
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { FloatingBrand } from "../components/FloatingBrand";
import type { TabParams } from "../navigation";
import { useTheme } from "../theme";
export function LocalHomeScreen() {
  const navigation = useNavigation<BottomTabNavigationProp<TabParams>>();
  const t = useTheme();
  return <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 32 }}>
    <View style={{ alignItems: "center", gap: 6, paddingTop: 8 }}>
      <FloatingBrand size={145} />
      <Text style={{ color: t.text, fontSize: 40, fontWeight: "800", letterSpacing: -1 }}>Pers<Text style={{ color: t.accent }}>AI</Text></Text>
      <Text style={{ color: t.muted, lineHeight: 23, textAlign: "center" }}>Ваш личный помощник{"\n"}с памятью и свободой выбора</Text>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Спросить ассистента" onPress={() => navigation.navigate("DirectAgent")}
      style={{ padding: 18, minHeight: 62, borderRadius: 21, backgroundColor: t.panel, borderColor: t.line, borderWidth: 1, flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Feather name="message-circle" color={t.accent} size={23} /><Text style={{ color: t.text, fontSize: 16, flex: 1 }}>Чем помочь?</Text><Feather name="arrow-right" size={23} color={t.accent} />
    </Pressable>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      {[
        { label: "Написать текст", icon: "edit-3" as const, prompt: "Помоги написать текст" },
        { label: "Объяснить идею", icon: "sun" as const, prompt: "Объясни мне сложную идею простыми словами" },
        { label: "Составить план", icon: "calendar" as const, prompt: "Помоги составить план на неделю" },
        { label: "Вспомнить важное", icon: "bookmark" as const, prompt: "Что ты помнишь обо мне?" },
      ].map(item => <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={item.label} onPress={() => navigation.navigate("DirectAgent", { initialPrompt: item.prompt })}
        style={{ width: "47%", flexGrow: 1, minHeight: 100, padding: 17, gap: 12, borderWidth: 1, borderColor: t.line, borderRadius: 21, backgroundColor: t.panel }}>
        <Feather name={item.icon} color={t.accent} size={23} /><Text style={{ color: t.text, fontWeight: "600" }}>{item.label}</Text>
      </Pressable>)}
    </View>
    <LinearGradient colors={["#337BFF", "#7061F8", "#C282F4"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: 24, borderRadius: 25, gap: 11 }}>
      <Text style={{ color: "#fff", fontSize: 23, fontWeight: "800" }}>Больше, чем ответы</Text>
      <Text style={{ color: "#fff", lineHeight: 22 }}>Сохраняйте важное, возвращайтесь к своим идеям и стройте планы вместе с PersAI.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Открыть личную память" onPress={() => navigation.navigate("LocalMemory")} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: "#fff", fontWeight: "700" }}>Моя память →</Text></Pressable>
    </LinearGradient>
    <Pressable accessibilityRole="button" accessibilityLabel="Настроить модели" onPress={() => navigation.navigate("Settings")} style={{ minHeight: 46, justifyContent: "center" }}><Text style={{ color: t.accent, textAlign: "center" }}>Выбрать модель и настроить подключения</Text></Pressable>
  </ScrollView>;
}
