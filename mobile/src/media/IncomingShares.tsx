import { memoryErrorMessage } from "../local-memory/errors";
import React, { useEffect, useRef } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { copyAsync } from 'expo-file-system/legacy';
import { useProfile } from '../profile/ProfileContext';
import { useApplicationVisible } from '../security/visibility';
import { localMemorySessionUnlocked } from '../local-memory/storage';
import { saveMediaNote } from './attachments';
import { scheduleVectors } from "./vector-runner";

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
      scheduleVectors(profile);
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

/** Open a draft after unlock; no automatic note and no top banner. */
export function IncomingShares({ open }: { open: (payloads: Sharing.SharePayload[]) => boolean }) {
  const profile = useProfile(); const visible = useApplicationVisible();
  const openRef = useRef(open); openRef.current = open;
  useEffect(() => {
    const poll = () => {
      if (Platform.OS !== 'android' || !profile || !visible || !localMemorySessionUnlocked()) return;
      const payloads = Sharing.getSharedPayloads();
      if (!payloads.length) return;
      if (openRef.current(payloads)) Sharing.clearSharedPayloads();
    };
    poll();
    const timer = setInterval(poll, 500);
    const app = AppState.addEventListener('change', state => { if (state === 'active') poll(); });
    const link = Linking.addEventListener('url', poll);
    return () => { clearInterval(timer); app.remove(); link.remove(); };
  }, [profile, visible]);
  return null;
}
