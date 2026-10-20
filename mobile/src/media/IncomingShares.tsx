import { memoryErrorMessage } from "../local-memory/errors";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, Pressable, Text, View } from 'react-native';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { useProfile } from '../profile/ProfileContext';
import { useApplicationVisible } from '../security/visibility';
import { localMemorySessionUnlocked } from '../local-memory/storage';
import { saveMediaNote } from './attachments';
import { useTheme } from '../theme';

/** Raw shares only: resolving a URL would make an unsolicited network request. */
export async function receiveShares(profile: string, payloads: Sharing.SharePayload[], signal?: AbortSignal) {
  if (payloads.length > 30) throw new Error('Отправляйте не более 30 файлов за один раз.');
  const ids: string[] = [];
  for (const payload of payloads) {
    if (signal?.aborted || !localMemorySessionUnlocked()) throw new Error('Разблокируйте приложение для завершения приёма.');
    const text = payload.shareType === 'text' || payload.shareType === 'url';
    if (!payload.value || (text && payload.value.length > 60_000)) throw new Error('Пустой или слишком длинный входящий текст (максимум 60 000 символов).');
    const receipt = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(payload));
    const file = text ? undefined : new File(payload.value);
    ids.push(await saveMediaNote(profile, {
      file: file ? { uri: file.uri, name: file.name || 'Входящий файл', mimeType: payload.mimeType } : undefined,
      title: file?.name || (payload.shareType === 'url' ? 'Ссылка' : payload.value.split('\n')[0].slice(0, 160)),
      body: text ? payload.value : '', sensitivity: 'sensitive', receipt,
    }, signal));
  }
  return ids;
}

export function IncomingShares({ open }: { open: (id: string) => void }) {
  const profile = useProfile(); const visible = useApplicationVisible(); const t = useTheme();
  const [notice, setNotice] = useState(''); const [last, setLast] = useState(''); const [failed, setFailed] = useState(false);
  const [request, setRequest] = useState(0);
  const active = useRef(false); const again = useRef(false); const controller = useRef<AbortController | null>(null);
  const poll = useCallback(async () => {
    if (Platform.OS !== 'android' || !profile || !visible || !localMemorySessionUnlocked()) return;
    if (active.current) { again.current = true; return; }
    active.current = true;
    const aborter = new AbortController(); controller.current = aborter;
    try {
      const payloads = Sharing.getSharedPayloads();
      if (!payloads.length) return;
      setFailed(false); setLast(''); setNotice(`Сохраняем во «Входящие»: ${payloads.length}…`);
      const ids = await receiveShares(profile, payloads, aborter.signal);
      // Do not clear a newer intent that arrived while copying the previous group.
      if (JSON.stringify(Sharing.getSharedPayloads()) === JSON.stringify(payloads)) Sharing.clearSharedPayloads();
      setLast(ids[ids.length - 1]); setNotice(`Во «Входящих» сохранено: ${ids.length}. Только на телефоне.`);
    } catch (error) { setNotice('Приём не завершён: ' + memoryErrorMessage(error)); setFailed(true); }
    finally { active.current = false; controller.current = null; if (again.current) { again.current = false; setRequest(n => n + 1); } }
  }, [profile, visible]);
  useEffect(() => {
    void poll();
    const app = AppState.addEventListener('change', state => { if (state === 'active') void poll(); });
    const link = Linking.addEventListener('url', () => { void poll(); });
    return () => { controller.current?.abort(); app.remove(); link.remove(); };
  }, [poll, request]);
  if (!visible || !notice) return null;
  return <View style={{ padding: 12, backgroundColor: t.panel, gap: 8 }}>
    <Text accessibilityRole="alert" style={{ color: t.text }}>{notice}</Text>
    {last ? <Pressable accessibilityRole="button" onPress={() => open(last)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: t.accent }}>Открыть запись</Text></Pressable> : null}
    {failed ? <Pressable accessibilityRole="button" onPress={() => void poll()} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: t.accent }}>Повторить приём</Text></Pressable> : null}
    <Pressable accessibilityRole="button" onPress={() => setNotice('')} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: t.muted }}>Скрыть уведомление</Text></Pressable>
  </View>;
}
