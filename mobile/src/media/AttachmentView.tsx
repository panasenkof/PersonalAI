import { memoryErrorMessage } from "../local-memory/errors";
import React, { useEffect, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { File } from 'expo-file-system';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useApplicationVisible } from '../security/visibility';
import { useTheme } from '../theme';
import { attachmentForEntity, materializeAttachment } from './attachments';
import type { Attachment } from './attachments';

function Player({ uri, onError }: { uri: string; onError: (message: string) => void }) {
  const player = useVideoPlayer(uri);
  useEffect(() => { const sub = player.addListener('statusChange', event => { if (event.status === 'error') onError('Не удалось воспроизвести этот формат на телефоне. Оригинал сохранён.'); }); return () => sub.remove(); }, [player, onError]);
  return <VideoView player={player} nativeControls style={{ width: '100%', height: 220 }} allowsPictureInPicture={false} />;
}
export function AttachmentView({ profile, entityId }: { profile: string; entityId: string }) {
  const t = useTheme(); const appVisible = useApplicationVisible(); const focused = useIsFocused(); const visible = appVisible && focused;
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uri, setUri] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; if (visible) void attachmentForEntity(profile, entityId).then(a => { if (alive) setAttachment(a); }).catch(e => { if (alive) setError(memoryErrorMessage(e)); }); return () => { alive = false; }; }, [profile, entityId, visible]);
  useEffect(() => {
    let alive = true; let temporary = ''; const controller = new AbortController();
    if (busy && visible && attachment) void materializeAttachment(profile, attachment, controller.signal).then(value => {
      temporary = value;
      if (alive) setUri(value); else { const file = new File(value); if (file.exists) file.delete(); }
    }).catch(e => { if (alive) setError(memoryErrorMessage(e)); });
    return () => { alive = false; controller.abort(); if (temporary) { const file = new File(temporary); if (file.exists) file.delete(); } };
  }, [busy, visible, attachment, profile]);
  useEffect(() => { if (!visible) { setUri(''); setBusy(false); } }, [visible]);
  if (!attachment) return error ? <Text style={{ color: t.err }}>{error}</Text> : null;
  const image = attachment.mime.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|heic)$/i.test(attachment.name);
  const playable = /^(audio|video)\//.test(attachment.mime) || /\.(mp3|wav|m4a|ogg|mp4|mov|webm|mkv)$/i.test(attachment.name);
  return <View style={{ gap: 10 }}>
    <Text style={{ color: t.text }}>Оригинал: {attachment.name} · {(attachment.size / 1024 / 1024).toFixed(1)} МБ</Text>
    {image || playable ? <Pressable accessibilityRole="button" disabled={busy && !uri && !error} style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => { setError(''); if (busy) { setBusy(false); setUri(''); } else setBusy(true); }}><Text style={{ color: t.accent }}>{busy ? (uri ? 'Закрыть оригинал' : error ? 'Сбросить просмотр' : 'Подготовка оригинала…') : 'Открыть оригинал'}</Text></Pressable> : <Text style={{ color: t.muted }}>Оригинал сохранён в резервной копии; просмотр этого формата пока не поддерживается.</Text>}
    {uri && visible ? image ? <Image source={{ uri }} resizeMode="contain" style={{ width: '100%', height: 280 }} /> : playable ? <Player uri={uri} onError={setError} /> : null : null}
    {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
  </View>;
}
