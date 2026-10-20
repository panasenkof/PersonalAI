import { memoryErrorMessage } from "../local-memory/errors";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, Pressable, Text, View } from 'react-native';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { copyAsync } from 'expo-file-system/legacy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
    let stage = 'SHARE-HASH';
    let staged: File | undefined;
    try {
      const receipt = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(payload));
      stage = 'SHARE-FILE';
      const original = text ? undefined : new File(payload.value);
      if (original && payload.value.startsWith('content://')) {
        // Generic Gallery/FileProvider URIs are not SAF document/tree URIs.
        // Legacy copy uses ContentResolver.openInputStream without DocumentFile metadata.
        stage = 'SHARE-COPY';
        const dir = new Directory(Paths.cache, 'persai-incoming');
        dir.create({ intermediates: true, idempotent: true });
        staged = new File(dir, Crypto.randomUUID());
        await copyAsync({ from: payload.value, to: staged.uri });
        if (signal?.aborted || !localMemorySessionUnlocked()) throw new Error('Приём остановлен. Повторите после разблокировки.');
      }
      const file = staged || original;
      stage = text ? 'SHARE-SAVE-TEXT' : 'SHARE-SAVE-MEDIA';
      ids.push(await saveMediaNote(profile, {
        file: file ? { uri: file.uri, name: original?.name || 'Входящий файл', mimeType: payload.mimeType } : undefined,
        title: original?.name || (payload.shareType === 'url' ? 'Ссылка' : payload.value.split('\n')[0].slice(0, 160)),
        body: text ? payload.value : '', sensitivity: 'sensitive', receipt,
      }, signal));
    } catch (error) {
      const message = memoryErrorMessage(error);
      const fallback = memoryErrorMessage(undefined);
      // Only a fixed stage code leaves this boundary: native errors can contain private URIs or SQL.
      throw new Error(`${message === fallback ? 'Не удалось сохранить материал.' : message} Код: ${stage}; элемент ${ids.length + 1}/${payloads.length}.`);
    } finally {
      if (staged?.exists) staged.delete();
    }
  }
  return ids;
}

export function IncomingShares({ open }: { open: (id: string) => void }) {
  const profile = useProfile(); const visible = useApplicationVisible(); const t = useTheme(); const insets = useSafeAreaInsets();
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
  return <View testID="incoming-share-notice" style={{ paddingHorizontal: 12, paddingBottom: 4, paddingTop: insets.top + 8, backgroundColor: t.panel, gap: 4 }}>
    <Text accessibilityRole="alert" style={{ color: t.text }}>{notice}</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 20 }}>
    {last ? <Pressable accessibilityRole="button" onPress={() => open(last)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: t.accent }}>Открыть запись</Text></Pressable> : null}
    {failed ? <Pressable accessibilityRole="button" onPress={() => void poll()} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: t.accent }}>Повторить приём</Text></Pressable> : null}
    <Pressable accessibilityRole="button" onPress={() => setNotice('')} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: t.muted }}>Скрыть</Text></Pressable>
    </View>
  </View>;
}
