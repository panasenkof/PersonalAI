import React from "react";
import { Pressable, Text, View } from "react-native";
import type { useTheme } from "../../theme";
import { PROVIDER_PRESETS } from "../../direct-agent/settings";
import { KIND_NAMES, type MemorySection } from "../../direct-agent/fact-tool";
import type { ChatDraft } from "../../direct-agent/conversations";
import { NebulaAction } from "../../design/nebula/components";
import { NebulaHomeArtwork } from "../../design/nebula/NebulaHomeArtwork";
import { nebulaSpacing } from "../../design/nebula/tokens";

/** Unchanged empty chat and first-run onboarding; navigation remains in HomeScreen. */
export function ChatEmptyState({
  ready, needsSetup, busy, orbPhase, artworkSize, t, onOpenConnections,
}: {
  ready: boolean;
  needsSetup: boolean;
  busy: boolean;
  orbPhase: React.ComponentProps<typeof NebulaHomeArtwork>["phase"];
  artworkSize: number;
  t: ReturnType<typeof useTheme>;
  onOpenConnections: (presetId?: string) => void;
}) {
  return ready && needsSetup ? <View style={{ flex: 1, justifyContent: "center", gap: 14, paddingVertical: 12 }}>
        <View style={{ alignItems: "center", gap: 10 }}><NebulaHomeArtwork size={136} phase={orbPhase} />
          <Text style={{ color: t.text, fontSize: 26, fontWeight: "800", textAlign: "center" }}>Подключите модель</Text>
          <Text style={{ color: t.muted, lineHeight: 21, textAlign: "center", maxWidth: 340 }}>PersAI работает с моделью, которую выбираете вы. Память и диалоги остаются на телефоне.</Text></View>
        <View style={{ backgroundColor: t.panel, borderWidth: 1, borderColor: t.line, borderRadius: 18, padding: 16, gap: 6 }}>
          {["1. Выберите сервис", "2. Вставьте ключ API", "3. Нажмите «Проверить связь» и сохраните", "4. Задайте первый вопрос"].map(step =>
            <Text key={step} style={{ color: t.text, lineHeight: 22 }}>{step}</Text>)}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          {PROVIDER_PRESETS.slice(0, 4).map(p => <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={"Начать с " + p.name}
            style={{ flexBasis: "45%", flexGrow: 1, minHeight: 56, justifyContent: "center", backgroundColor: t.panel, borderWidth: 1, borderColor: t.accent, borderRadius: 16, padding: 12 }}
            onPress={() => onOpenConnections(p.id)}><Text style={{ color: t.accent, fontWeight: "700" }}>{p.name}</Text></Pressable>)}
        </View>
        <NebulaAction icon="settings" label="Другие варианты подключения"
          accessibilityLabel="Другие варианты, включая OpenAI и Anthropic"
          onPress={() => onOpenConnections()} />
      </View> : ready && !busy ? <View testID="nebula-home-empty-state"
        style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 12 }}>
        {artworkSize > 0 ? <NebulaHomeArtwork size={artworkSize} phase={orbPhase} /> : null}
      </View> : null;
}

/** Footer for pending memory drafts; selection and saving use the existing
 * authoritative confirmation methods injected by HomeScreen. */
export function ChatDraftFooter({
  drafts, sections, savingDraft, t, onSetDraftSection, onApprove, onDismiss,
}: {
  drafts?: ChatDraft[];
  sections: MemorySection[];
  savingDraft?: string;
  t: ReturnType<typeof useTheme>;
  onSetDraftSection: (draft: ChatDraft, section: string | null) => void;
  onApprove: (draft: ChatDraft) => void;
  onDismiss: (draft: ChatDraft) => void;
}) {
  return <View style={{ gap: 10 }}>
        {drafts?.map(d => <View key={d.id} style={{ backgroundColor: t.panel, borderWidth: 1, borderColor: t.accent, borderRadius: 20, padding: 16, gap: 8 }}>
          <Text style={{ color: t.accent, fontWeight: "700" }}>Запомнить?</Text><Text selectable style={{ color: t.text, fontWeight: "700" }}>{d.title}</Text><Text selectable style={{ color: t.text }}>{d.body}</Text>
          {d.kind || d.person || d.date ? <Text style={{ color: t.muted, fontSize: 13 }}>{[d.kind ? KIND_NAMES[d.kind] : "", d.person ? (d.kind === "person" ? "имя: " : "о ком: ") + d.person : "", d.date ? "дата: " + new Date(d.date + "T00:00:00").toLocaleDateString() : ""].filter(Boolean).join(" · ")}</Text> : null}
          <Text style={{ color: t.muted, fontSize: 12 }}>Раздел</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {[...sections.map(x => ({ key: x.slug, slug: x.slug as string | null, name: x.name, label: "Сохранить в раздел " + x.name })),
              ...(d.newSection && !sections.some(x => x.name.toLowerCase() === d.newSection!.toLowerCase()) ? [{ key: "new", slug: null, name: "+ Новый раздел «" + d.newSection + "»", label: "Создать раздел " + d.newSection + " и сохранить в него" }] : [])]
              .map(x => { const chosen = x.slug ? (d.section || (d.newSection ? "" : "notes")) === x.slug : !d.section; return <Pressable key={x.key} accessibilityRole="button"
              accessibilityLabel={x.label} accessibilityState={{ selected: chosen }} aria-selected={chosen} disabled={Boolean(savingDraft)} onPress={() => onSetDraftSection(d, x.slug)}
              style={{ minHeight: 36, paddingHorizontal: 10, justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: chosen ? t.accent : t.line, backgroundColor: chosen ? t.soft : t.panel }}>
              <Text style={{ color: chosen ? t.accent : t.text, fontSize: 13 }}>{x.name}</Text></Pressable>; })}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: nebulaSpacing.sm }}>
            <NebulaAction icon="check" label={savingDraft === d.id ? "Сохранение…" : "Сохранить"}
              variant="primary" disabled={Boolean(savingDraft)} onPress={() => onApprove(d)} />
            <NebulaAction icon="x" label="Отклонить" size="compact" disabled={Boolean(savingDraft)}
              onPress={() => onDismiss(d)} />
          </View>
        </View>)}

      </View>;
}
