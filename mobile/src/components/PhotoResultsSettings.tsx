import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { useTheme } from "../theme";
import { Collapsible } from "./Collapsible";
import { DEFAULT_PHOTO_RESULT_COUNT, PHOTO_RESULT_COUNTS, loadPhotoResultCount, savePhotoResultCount, type PhotoResultCount } from "../media/photo-result-preferences";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";

export function PhotoResultsSettings() {
  const profile = useProfile();
  const t = useTheme();
  const [count, setCount] = useState<PhotoResultCount>(DEFAULT_PHOTO_RESULT_COUNT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setError("");
    void loadPhotoResultCount(profile).then(value => { if (alive) setCount(value); })
      .catch(() => { if (alive) setError("Не удалось загрузить число результатов."); });
    return () => { alive = false; };
  }, [profile]);
  async function select(value: PhotoResultCount) {
    if (busy || value === count) return;
    setBusy(true); setError("");
    try { await savePhotoResultCount(profile, value); setCount(value); }
    catch { setError("Не удалось сохранить настройку. Повторите попытку."); }
    finally { setBusy(false); }
  }
  return <Collapsible id="settings.photo-results" icon="image" title="Выдача найденных фото"
    summary={`Показывать до ${count} · первое фото открыто`}>
    <Text style={{ color: t.text, fontWeight: "600" }}>Максимум результатов поиска</Text>
    <Text style={{ color: t.muted, fontSize: 12 }}>Только релевантные фотографии. Лучшее видно сразу, остальные свёрнуты. Настройка сохраняется на этом устройстве для вашего профиля.</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: nebulaSpacing.sm }}>
      {PHOTO_RESULT_COUNTS.map(value => <Pressable key={value} accessibilityRole="button"
        accessibilityLabel={`Показывать до ${value} найденных фотографий`}
        accessibilityState={{ selected: count === value, disabled: busy }}
        disabled={busy} onPress={() => void select(value)}
        style={{ minWidth: nebulaTouch.minimum, minHeight: nebulaTouch.minimum,
          paddingHorizontal: nebulaSpacing.md, alignItems: "center", justifyContent: "center",
          borderWidth: 1, borderColor: count === value ? t.accent : t.line,
          backgroundColor: count === value ? t.soft : t.panel, borderRadius: nebulaRadii.pill }}>
        <Text style={{ color: count === value ? t.accent : t.text, fontWeight: count === value ? "700" : "500" }}>{value}</Text>
      </Pressable>)}
    </View>
    {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
  </Collapsible>;
}
