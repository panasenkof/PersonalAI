import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { DirectConnection } from '../direct-agent/settings';
import { loadMediaPreferences, saveMediaPreferences, type MediaPreferences } from './preferences';
import { useTheme } from '../theme';
export function MediaSettings({ profile, connections }: { profile: string; connections: DirectConnection[] }) {
  const t = useTheme(); const [prefs, setPrefs] = useState<MediaPreferences>({ visionId: '', speechId: '' });
  const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(true);
  useEffect(() => { let alive = true; void loadMediaPreferences(profile).then(p => { if (alive) setPrefs(p); }).catch(() => { if (alive) setNotice('Не удалось загрузить настройки медиа.'); }).finally(() => { if (alive) setBusy(false); }); return () => { alive = false; }; }, [profile]);
  return <View style={{ gap: 10 }}>
    <Text style={{ color: t.text, fontWeight: '700' }}>Обработка медиа</Text>
    <Text style={{ color: t.muted }}>Ключи берутся из сохранённых подключений. Для речи используется установленный Whisper; иначе выбранный сервис с /audio/transcriptions.</Text>
    {([['visionId', 'Изображения и кадры видео'], ['speechId', 'Речь из аудио и видео']] as const).map(([field, label]) => <View key={field}>
      <Text style={{ color: t.text }}>{label}</Text>
      {[{ id: '', name: 'Активное подключение' }, ...connections].map(c => <Pressable key={c.id} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: prefs[field] === c.id }} onPress={() => setPrefs(p => ({ ...p, [field]: c.id }))} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: prefs[field] === c.id ? t.accent : t.text }}>{prefs[field] === c.id ? '● ' : '○ '}{c.name}</Text></Pressable>)}
    </View>)}
    <Pressable disabled={busy} accessibilityRole="button" style={{ minHeight: 44 }} onPress={() => { setBusy(true); void saveMediaPreferences(profile, prefs).then(() => setNotice('Настройки медиа сохранены.')).catch(() => setNotice('Не удалось сохранить настройки.')).finally(() => setBusy(false)); }}><Text style={{ color: t.accent }}>Сохранить выбор для медиа</Text></Pressable>
    {notice ? <Text style={{ color: t.muted }}>{notice}</Text> : null}
  </View>;
}
