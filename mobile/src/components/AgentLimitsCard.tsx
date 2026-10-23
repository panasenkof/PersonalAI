import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { loadModelCallLimit, saveModelCallLimit } from "../direct-agent/agent-preferences";
import { DEFAULT_MODEL_CALL_LIMIT, MAX_MODEL_CALL_LIMIT, validateModelCallLimit } from "../direct-agent/limits";
import { useProfile } from "../profile/ProfileContext";
import { useTheme } from "../theme";
import { Collapsible } from "./Collapsible";

export function AgentLimitsCard() {
  const profile = useProfile(); const t = useTheme();
  const [draft, setDraft] = useState(String(DEFAULT_MODEL_CALL_LIMIT));
  const [saved, setSaved] = useState(DEFAULT_MODEL_CALL_LIMIT);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const mounted = useRef(false); const savingNow = useRef(false);
  useEffect(() => {
    let alive = true;
    mounted.current = true;
    void loadModelCallLimit(profile).then(value => {
      if (alive) { setDraft(String(value)); setSaved(value); }
    }).catch(() => { if (alive) setError("Не удалось загрузить лимит. Задайте значение и сохраните заново."); })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; mounted.current = false; };
  }, [profile]);
  const valid = /^\d+$/.test(draft.trim()) && Number(draft) >= 1 && Number(draft) <= MAX_MODEL_CALL_LIMIT;
  const change = (value: string) => { setDraft(value); setError(""); setNotice(""); };
  async function save() {
    if (!loaded || savingNow.current) return;
    let value: number;
    try { value = validateModelCallLimit(valid ? Number(draft) : NaN); }
    catch (e) { setError((e as Error).message); return; }
    savingNow.current = true; setSaving(true); setError(""); setNotice("");
    try {
      await saveModelCallLimit(profile, value);
      if (mounted.current) { setSaved(value); setDraft(String(value)); setNotice("Лимит сохранён. Он действует для следующих сообщений."); }
    } catch { if (mounted.current) setError("Не удалось сохранить лимит. Прежнее значение остаётся в силе; повторите сохранение."); }
    finally { savingNow.current = false; if (mounted.current) setSaving(false); }
  }
  const step = { minHeight: 46, minWidth: 46, alignItems: "center" as const, justifyContent: "center" as const, borderRadius: 14, borderWidth: 1, borderColor: t.line };
  return <Collapsible icon="sliders" id="settings.agent-limits" title="Работа ИИ" summary={loaded ? `До ${saved} обращений к LLM на сообщение` : "Загружаю лимит…"}>
    <Text style={{ color: t.text, fontWeight: "600" }}>Максимум обращений к LLM на одно сообщение</Text>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Помощник обращается к модели, чтобы выбрать действие, обработать найденные сведения и ответить. Больше обращений позволяют выполнить больше шагов, но могут увеличить время и стоимость ответа. От 1 до 20, по умолчанию 4.</Text>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Уменьшить лимит обращений к LLM" disabled={!loaded || saving || !valid || Number(draft) <= 1} style={step} onPress={() => change(String(Number(draft) - 1))}><Text style={{ color: t.secondary, fontSize: 24 }}>−</Text></Pressable>
      <TextInput accessibilityLabel="Лимит обращений к LLM на сообщение" value={draft} onChangeText={change} editable={loaded && !saving} keyboardType="number-pad" inputMode="numeric" selectTextOnFocus
        style={{ minHeight: 46, width: 80, borderWidth: 1, borderColor: t.line, borderRadius: 14, padding: 10, color: t.text, textAlign: "center", fontSize: 20 }} />
      <Pressable accessibilityRole="button" accessibilityLabel="Увеличить лимит обращений к LLM" disabled={!loaded || saving || !valid || Number(draft) >= MAX_MODEL_CALL_LIMIT} style={step} onPress={() => change(String(Number(draft) + 1))}><Text style={{ color: t.secondary, fontSize: 24 }}>+</Text></Pressable>
    </View>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Лимит действует на основные шаги ответа, отдельно для каждого сообщения и для всех подключений этого профиля. Служебные запросы, проверка связи и кнопка «Улучшить» имеют собственные ограничения. Денежный бюджет задаётся у провайдера.</Text>
    {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={{ color: t.ok }}>{notice}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Сохранить лимит обращений к LLM" disabled={!loaded || saving} onPress={() => void save()}
      style={{ minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: 14, padding: 12, backgroundColor: t.accent, opacity: !loaded || saving ? 0.5 : 1 }}>
      <Text style={{ color: "#fff", fontWeight: "600" }}>{saving ? "Сохраняю…" : "Сохранить лимит"}</Text>
    </Pressable>
  </Collapsible>;
}
