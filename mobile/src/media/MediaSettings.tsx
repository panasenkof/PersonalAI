import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { DirectConnection } from "../direct-agent/settings";
import { loadMediaPreferences, saveMediaPreferences, type MediaPreferences } from "./preferences";
import { nebulaRadii, nebulaSpacing, nebulaTouch, nebulaTypography } from "../design/nebula/tokens";
import { useTheme } from "../theme";

/** One owner for recognition routing: Settings → Multimedia.
 * Changes are committed immediately rather than leaving a second hidden Save
 * inside the connection editor. No credentials are copied or displayed here.
 */
export function MediaSettings({ profile, connections }: { profile: string; connections: DirectConnection[] }) {
  const t = useTheme();
  const [prefs, setPrefs] = useState<MediaPreferences>({ visionId: "", speechId: "" });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const savingNow = useRef(false);

  useEffect(() => {
    const generationAtStart = ++generation.current;
    setLoaded(false);
    setError("");
    setNotice("");
    savingNow.current = false;
    void loadMediaPreferences(profile)
      .then(value => { if (generationAtStart === generation.current) setPrefs(value); })
      .catch(() => { if (generationAtStart === generation.current) setError("Не удалось загрузить выбор для медиа. Повторно откройте настройки."); })
      .finally(() => { if (generationAtStart === generation.current) setLoaded(true); });
    return () => { generation.current++; };
  }, [profile]);

  async function choose(field: keyof MediaPreferences, id: string) {
    if (!loaded || savingNow.current || prefs[field] === id) return;
    if (id && !connections.some(c => c.id === id)) { setError("Подключение больше не существует. Выберите доступное."); return; }
    const next = { ...prefs, [field]: id };
    const currentGeneration = generation.current;
    savingNow.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveMediaPreferences(profile, next);
      if (currentGeneration === generation.current) {
        setPrefs(next);
        setNotice("Выбор для медиа сохранён.");
      }
    } catch {
      if (currentGeneration === generation.current) setError("Не удалось сохранить выбор. Прежнее подключение остаётся действующим.");
    } finally {
      if (currentGeneration === generation.current) {
        savingNow.current = false;
        setSaving(false);
      }
    }
  }

  const missing = (["visionId", "speechId"] as const)
    .some(field => prefs[field] && !connections.some(c => c.id === prefs[field]));
  const options = [{ id: "", name: "Активное подключение" }, ...connections];
  return <View style={{ gap: nebulaSpacing.sm }}>
    <Text style={{ color: t.muted, ...nebulaTypography.label }}>
      Выберите отдельные подключения для изображений и речи. Изменение сохраняется сразу при выборе, без второго нажатия «Сохранить».
    </Text>
    {(["visionId", "speechId"] as const).map(field => {
      const label = field === "visionId" ? "Изображения и кадры видео" : "Речь из аудио и видео";
      return <View key={field} style={{ gap: nebulaSpacing.xs }}>
        <Text style={{ color: t.text, ...nebulaTypography.body, fontWeight: "600" }}>{label}</Text>
        {options.map(c => {
          const checked = prefs[field] === c.id;
          return <Pressable key={c.id} accessibilityRole="radio"
            accessibilityLabel={label + ": " + c.name}
            accessibilityState={{ checked, disabled: !loaded || saving }}
            disabled={!loaded || saving}
            onPress={() => void choose(field, c.id)}
            style={{ minHeight: nebulaTouch.minimum, borderWidth: 1, borderColor: checked ? t.secondary : t.line,
              borderRadius: nebulaRadii.field, backgroundColor: checked ? t.soft : t.panel,
              paddingHorizontal: nebulaSpacing.md, paddingVertical: nebulaSpacing.sm,
              flexDirection: "row", alignItems: "center", gap: nebulaSpacing.sm,
              opacity: !loaded || saving ? 0.6 : 1 }}>
            <Text style={{ color: checked ? t.secondary : t.text, ...nebulaTypography.label }}>{checked ? "●" : "○"} {c.name}</Text>
          </Pressable>;
        })}
      </View>;
    })}
    {missing ? <Text accessibilityRole="alert" style={{ color: t.err }}>
      Одно из выбранных подключений удалено. Выберите актуальное подключение.
    </Text> : null}
    {!loaded || saving ? <Text accessibilityLiveRegion="polite" style={{ color: t.muted }}>
      {saving ? "Сохраняю выбор для медиа…" : "Загружаю настройки медиа…"}
    </Text> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={{ color: t.ok }}>{notice}</Text> : null}
  </View>;
}
