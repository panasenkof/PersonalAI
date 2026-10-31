import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { useTheme } from "../theme";
import { Collapsible } from "./Collapsible";
import { NumericStepper } from "./NumericStepper";
import { DEFAULT_PHOTO_RESULT_COUNT, MAX_PHOTO_RESULT_COUNT, loadPhotoResultCount, savePhotoResultCount } from "../media/photo-result-preferences";

export function PhotoResultsSettings() {
  const profile = useProfile();
  const t = useTheme();
  const [draft, setDraft] = useState(String(DEFAULT_PHOTO_RESULT_COUNT));
  const [saved, setSaved] = useState(DEFAULT_PHOTO_RESULT_COUNT);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false), savingNow = useRef(false);
  useEffect(() => {
    let alive = true;
    mounted.current = true;
    setLoaded(false); setError(""); setNotice("");
    void loadPhotoResultCount(profile).then(value => {
      if (alive) { setDraft(String(value)); setSaved(value); }
    }).catch(() => { if (alive) setError("Не удалось загрузить число результатов."); })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; mounted.current = false; };
  }, [profile]);
  const valid = /^\d+$/.test(draft.trim()) && Number(draft) >= 1 && Number(draft) <= MAX_PHOTO_RESULT_COUNT;
  const change = (value:string) => {setDraft(value);setError("");setNotice("");};
  async function save() {
    if (!loaded || savingNow.current) return;
    if (!valid) {setError("Введите число от 1 до 20.");return;}
    savingNow.current = true; setSaving(true); setError(""); setNotice("");
    try {
      const value=Number(draft);
      await savePhotoResultCount(profile,value);
      if (mounted.current) {
        setSaved(value);setDraft(String(value));
        setNotice("Сохранено. Число результатов действует для следующих поисков.");
      }
    } catch {
      if (mounted.current) setError("Не удалось сохранить настройку. Прежнее значение остаётся в силе.");
    } finally {
      savingNow.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return <Collapsible id="settings.photo-results" icon="image" title="Выдача найденных фото"
    summary={loaded ? `Показывать до ${saved} фото` : "Загружаю настройку…"}>
    <Text style={{color:t.text,fontWeight:"600"}}>Максимум найденных фотографий</Text>
    <Text style={{color:t.muted,fontSize:12,lineHeight:18}}>
      От 1 до 20, по умолчанию 6. Самое подходящее фото видно сразу, остальные скрыты под кнопкой.
      Ограничение влияет только на показ: поиск по-прежнему отсекает неподходящие совпадения.
    </Text>
    <NumericStepper value={draft} onChange={change} min={1} max={MAX_PHOTO_RESULT_COUNT}
      disabled={!loaded||saving} inputLabel="Максимум найденных фотографий"
      decreaseLabel="Уменьшить количество найденных фотографий"
      increaseLabel="Увеличить количество найденных фотографий"/>
    {error ? <Text accessibilityRole="alert" style={{color:t.err}}>{error}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={{color:t.ok}}>{notice}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Сохранить количество найденных фотографий"
      disabled={!loaded||saving} onPress={()=>void save()}
      style={{minHeight:46,alignItems:"center",justifyContent:"center",borderRadius:14,padding:12,
        backgroundColor:t.accent,opacity:!loaded||saving?0.5:1}}>
      <Text style={{color:"#fff",fontWeight:"600"}}>{saving?"Сохраняю…":"Сохранить"}</Text>
    </Pressable>
  </Collapsible>;
}
