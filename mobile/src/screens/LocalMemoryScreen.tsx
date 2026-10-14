import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { BottomSheet } from "../components/BottomSheet";
import { localMemoryRepository } from "../local-memory/repository";
import type { SqliteMemoryRepository } from "../local-memory/repository";
import type { CollectionRecord, EntityRecord } from "../local-memory/types";
import { memoryErrorMessage } from "../local-memory/errors";
import type { RootStackParams } from "../navigation";
import { useTheme } from "../theme";

export function LocalMemoryScreen() {
  const t = useTheme(); const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useProfile();
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [collectionId, setCollectionId] = useState<string | undefined>();
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState(""); const [term, setTerm] = useState("");
  const [notes, setNotes] = useState<EntityRecord[]>([]); const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [retry, setRetry] = useState(0);
  const [sectionOpen, setSectionOpen] = useState(false); const [sectionName, setSectionName] = useState("");
  const repository = useRef<SqliteMemoryRepository | null>(null); const generation = useRef(0);
  useEffect(() => { const timer = setTimeout(() => setTerm(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { setCollectionId(undefined); setSearch(""); setStatus("active"); setCollections([]); setNotes([]); }, [profile]);
  useFocusEffect(useCallback(() => {
    const request = ++generation.current; setLoading(true); setError("");
    if (profile) void localMemoryRepository(profile).then(async db => {
      const [sections, page] = await Promise.all([db.listCollections(), db.searchNotes(term, 50, 0, { collectionId, status })]);
      if (request !== generation.current) return;
      repository.current = db; setCollections(sections); setNotes(page); setMore(page.length === 50);
    }).catch(e => { if (request === generation.current) { repository.current = null; setError(memoryErrorMessage(e)); } })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; repository.current = null; };
  }, [profile, term, collectionId, status, retry]));
  async function loadMore() {
    if (!repository.current || busy) return;
    const request = generation.current; setBusy(true);
    try {
      const page = await repository.current.searchNotes(term, 50, notes.length, { collectionId, status });
      if (request === generation.current) { setNotes(prev => [...prev, ...page]); setMore(page.length === 50); }
    } catch (e) { if (request === generation.current) setError(memoryErrorMessage(e)); }
    finally { setBusy(false); }
  }
  async function addSection() {
    if (!repository.current || busy || !sectionName.trim()) return;
    const request = generation.current; setBusy(true); setError("");
    try {
      const created = await repository.current.createCollection({ name: sectionName.trim(), slug: "section-" + Crypto.randomUUID(), sensitivity: "standard" });
      if (request === generation.current) { setCollections(prev => [...prev, created]); setCollectionId(created.id); setSectionName(""); setSectionOpen(false); }
    } catch (e) { if (request === generation.current) setError(memoryErrorMessage(e)); }
    finally { setBusy(false); }
  }
  const button = { minHeight: 48, justifyContent: "center" as const, alignItems: "center" as const, borderRadius: 16, paddingHorizontal: 16 };
  return <View style={{ flex: 1, backgroundColor: t.bg }}>
    <View style={{ padding: 18, paddingBottom: 10, gap: 14 }}>
      <Text style={{ color: t.text, fontSize: 27, fontWeight: "800" }}>Мои знания</Text>
      <Text style={{ color: t.muted, lineHeight: 20 }}>Рецепты, идеи, планы — разложите важное по темам.</Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Новая заметка" onPress={() => navigation.navigate("MemoryNote", { collectionId })} style={{ ...button, flex: 1, backgroundColor: t.accent }}><Text style={{ color: "#fff", fontWeight: "700" }}>+ Запись</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Добавить сведения из файла" onPress={() => navigation.navigate("MemoryImport")} style={{ ...button, backgroundColor: t.soft, gap: 4 }}><Feather name="paperclip" size={20} color={t.accent} /><Text style={{ color: t.accent, fontSize: 11 }}>Файл</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Резервные копии" onPress={() => navigation.navigate("MemoryBackup")} style={{ ...button, backgroundColor: t.soft, gap: 4 }}><Feather name="download-cloud" size={20} color={t.accent} /><Text style={{ color: t.accent, fontSize: 11 }}>Копии</Text></Pressable>
      </View>
      <TextInput accessibilityLabel="Поиск по заметкам" value={search} onChangeText={setSearch} placeholder="Найти в памяти" placeholderTextColor={t.muted} returnKeyType="search"
        style={{ backgroundColor: t.panel, color: t.text, borderWidth: 1, borderColor: t.line, borderRadius: 16, minHeight: 48, padding: 12 }} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>
        {[{ id: undefined, name: "Все записи" }, ...collections].map(c => <Pressable key={c.id || "all"} accessibilityRole="button" accessibilityLabel={"Раздел " + c.name} accessibilityState={{ selected: c.id === collectionId }} onPress={() => setCollectionId(c.id)} style={{ ...button, backgroundColor: c.id === collectionId ? t.soft : t.panel, borderWidth: 1, borderColor: c.id === collectionId ? t.accent : t.line }}><Text style={{ color: c.id === collectionId ? t.accent : t.text }}>{c.name}</Text></Pressable>)}
        <Pressable accessibilityRole="button" accessibilityLabel="Новый раздел памяти" onPress={() => setSectionOpen(true)} style={{ ...button, flexDirection: "row", gap: 6, borderWidth: 1, borderColor: t.line }}><Feather name="folder-plus" size={20} color={t.accent} /><Text style={{ color: t.accent }}>Раздел</Text></Pressable>
      </ScrollView>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
        <Text style={{ flex: 1, color: t.muted, fontSize: 12 }}>{loading ? "Загружаю…" : `${notes.length}${more ? "+" : ""} записей`}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={status === "active" ? "Открыть архив" : "Открыть текущие записи"} onPress={() => setStatus(s => s === "active" ? "archived" : "active")} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: t.accent }}>{status === "active" ? "Архив" : "Текущие записи"}</Text></Pressable>
      </View>
    </View>
    {error ? <View style={{ paddingHorizontal: 18, gap: 8 }}><Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text><Pressable accessibilityRole="button" onPress={() => setRetry(n => n + 1)} style={button}><Text style={{ color: t.accent }}>Повторить загрузку</Text></Pressable></View> : null}
    {loading ? <ActivityIndicator accessibilityLabel="Загрузка записей" /> : null}
    <FlatList data={loading ? [] : notes} keyExtractor={item => item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 24, gap: 10, flexGrow: 1 }}
      ListEmptyComponent={!loading && !error ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}><Feather name={term ? "search" : "book-open"} size={40} color={t.accent} />
        <Text style={{ color: t.text, fontSize: 20, fontWeight: "700", textAlign: "center" }}>{term ? "Ничего не найдено" : status === "archived" ? "Архив пуст" : "Начните с важного"}</Text>
        <Text style={{ color: t.muted, textAlign: "center", lineHeight: 21 }}>{term ? "Попробуйте другое слово или раздел «Все записи»." : "Создайте запись или добавьте сведения из файла."}</Text></View> : null}
      renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={"Открыть заметку " + (item.title || "Без названия")} onPress={() => navigation.navigate("MemoryNote", { entityId: item.id })}
        style={{ borderWidth: 1, borderColor: t.line, borderRadius: 20, backgroundColor: t.panel, padding: 17, gap: 8 }}>
        <Text numberOfLines={1} style={{ color: t.text, fontWeight: "700", fontSize: 17 }}>{item.title || "Без названия"}</Text><Text numberOfLines={2} style={{ color: t.muted, lineHeight: 21 }}>{String(item.payload.body || "")}</Text>
        <Text style={{ color: t.muted, fontSize: 11 }}>{collections.find(c => c.id === item.collection_id)?.name || "Запись"} · {new Date(item.updated_at).toLocaleDateString()}</Text>
      </Pressable>}
      ListFooterComponent={more && !loading ? <Pressable accessibilityRole="button" accessibilityLabel="Показать ещё заметки" disabled={busy} onPress={() => void loadMore()} style={button}><Text style={{ color: t.accent }}>{busy ? "Загружаю…" : "Показать ещё"}</Text></Pressable> : null} />
    <BottomSheet visible={sectionOpen} title="Новый раздел" onClose={() => setSectionOpen(false)}>
      <Text style={{ color: t.muted }}>Например: «Рецепты», «Идеи» или «Планы».</Text>
      <TextInput accessibilityLabel="Название раздела памяти" value={sectionName} onChangeText={setSectionName} maxLength={80} placeholder="Название" placeholderTextColor={t.muted} style={{ minHeight: 50, padding: 12, borderWidth: 1, borderColor: t.line, borderRadius: 16, color: t.text }} />
      <Pressable accessibilityRole="button" accessibilityLabel="Создать раздел" disabled={busy || !sectionName.trim()} onPress={() => void addSection()} style={{ ...button, backgroundColor: t.accent }}><Text style={{ color: "#fff", fontWeight: "700" }}>{busy ? "Создаю…" : "Создать раздел"}</Text></Pressable>
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
    </BottomSheet>
  </View>;
}
