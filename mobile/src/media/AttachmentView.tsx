import { memoryErrorMessage } from "../local-memory/errors";
import React, { useEffect, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { File } from "expo-file-system";
import { useVideoPlayer, VideoView } from "expo-video";
import { useApplicationVisible } from "../security/visibility";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";
import { attachmentsForEntity, materializeAttachment } from "./attachments";
import type { Attachment } from "./attachments";
import { attachmentKindLabel, attachmentPreviewKind, readableAttachmentSize } from "./attachmentPresentation";
import type { AttachmentPreviewKind } from "./attachmentPresentation";

function deleteTemporary(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // A security lock may already have purged the preview cache.
  }
}

function VideoPreview({ uri, onError }: { uri: string; onError: (message: string) => void }) {
  const player = useVideoPlayer(uri);
  useEffect(() => {
    const sub = player.addListener("statusChange", event => {
      if (event.status === "error") onError("Не удалось воспроизвести видео. Оригинал сохранён.");
    });
    return () => { player.pause(); sub.remove(); };
  }, [player, onError]);
  return <VideoView player={player} nativeControls style={{ width: "100%", height: 230 }} allowsPictureInPicture={false} />;
}

/** Audio does not need an empty black video surface. Playback starts only on a
 * second, explicit user action after decrypting the selected attachment. */
function AudioPreview({ uri, onError }: { uri: string; onError: (message: string) => void }) {
  const t = useTheme();
  const player = useVideoPlayer(uri);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const status = player.addListener("statusChange", event => {
      if (event.status === "error") onError("Не удалось воспроизвести аудио. Оригинал сохранён.");
    });
    const playback = player.addListener("playingChange", event => setPlaying(event.isPlaying));
    return () => { player.pause(); status.remove(); playback.remove(); };
  }, [player, onError]);
  return <Pressable accessibilityRole="button" accessibilityLabel={playing ? "Приостановить аудио" : "Воспроизвести аудио"}
    onPress={() => { if (playing) player.pause(); else player.play(); }}
    style={{ minHeight: nebulaTouch.minimum, justifyContent: "center", alignItems: "center", borderRadius: nebulaRadii.field, backgroundColor: t.soft }}>
    <Text style={{ color: t.secondary, fontWeight: "700" }}>{playing ? "Пауза" : "Воспроизвести"} · аудио</Text>
  </Pressable>;
}

export function AttachmentView({ profile, entityId }: { profile: string; entityId: string }) {
  const t = useTheme();
  const focused = useIsFocused();
  const appVisible = useApplicationVisible();
  const visible = focused && appVisible;
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    setOpenId(null); setAttachments([]); setError(""); setLoading(true);
    void attachmentsForEntity(profile, entityId)
      .then(items => { if (alive) setAttachments(items); })
      .catch(e => { if (alive) setError(memoryErrorMessage(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [profile, entityId, retry]);

  // Background, navigation away and app lock immediately disable all previews.
  useEffect(() => { if (!visible) setOpenId(null); }, [visible]);

  if (!loading && !error && attachments.length === 0) return null;
  return <View style={{ gap: nebulaSpacing.sm }}>
    <Text accessibilityRole="header" style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>Вложения{attachments.length ? " · " + attachments.length : ""}</Text>
    {loading ? <Text style={{ color: t.muted }}>Загружаю список вложений…</Text> : null}
    {error ? <>
      <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Повторить загрузку вложений" onPress={() => setRetry(x => x + 1)}
        style={{ minHeight: nebulaTouch.minimum, justifyContent: "center" }}>
        <Text style={{ color: t.secondary }}>Повторить загрузку</Text>
      </Pressable>
    </> : null}
    {attachments.map(attachment => <OneAttachment key={attachment.id} profile={profile} attachment={attachment}
      expanded={visible && openId === attachment.id} visible={visible}
      onToggle={() => setOpenId(id => id === attachment.id ? null : attachment.id)} />)}
  </View>;
}

function OneAttachment({ profile, attachment, expanded, visible, onToggle }: {
  profile: string;
  attachment: Attachment;
  expanded: boolean;
  visible: boolean;
  onToggle: () => void;
}) {
  const t = useTheme();
  const kind: AttachmentPreviewKind = attachmentPreviewKind(attachment);
  const supported = kind !== "unsupported";
  const [uri, setUri] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const active = expanded && visible && supported;

  useEffect(() => {
    let alive = true;
    let temporary = "";
    const controller = new AbortController();
    setUri("");
    setLoading(active);
    if (active) {
      setError("");
      void materializeAttachment(profile, attachment, controller.signal)
        .then(value => {
          temporary = value;
          if (alive && !controller.signal.aborted) setUri(value);
          else deleteTemporary(value);
        })
        .catch(e => { if (alive && !controller.signal.aborted) setError(memoryErrorMessage(e)); })
        .finally(() => { if (alive) setLoading(false); });
    }
    return () => {
      alive = false;
      controller.abort();
      if (temporary) deleteTemporary(temporary);
    };
  }, [active, attachment, profile, attempt]);

  const action = kind === "image" ? "Открыть фото" : kind === "audio" ? "Прослушать аудио" : "Открыть видео";
  return <View style={{ padding: nebulaSpacing.md, gap: nebulaSpacing.sm, borderWidth: 1, borderColor: t.line,
    backgroundColor: t.panel, borderRadius: nebulaRadii.card }}>
    <Text style={{ color: t.text, fontWeight: "700" }} numberOfLines={3}>{attachment.name}</Text>
    <Text style={{ color: t.muted }}>{attachmentKindLabel(kind)} · {readableAttachmentSize(attachment.size)}</Text>
    {supported ? <Pressable accessibilityRole="button" accessibilityLabel={action + " " + attachment.name}
      accessibilityState={{ expanded }} onPress={() => {
        if (expanded && error) { setAttempt(n => n + 1); return; }
        onToggle();
      }} style={{ minHeight: nebulaTouch.minimum, justifyContent: "center" }}>
      <Text style={{ color: t.secondary, fontWeight: "700" }}>{expanded ? error ? "Повторить просмотр" : "Закрыть просмотр" : action}</Text>
    </Pressable> : <Text style={{ color: t.muted }}>Оригинал сохранён в зашифрованной памяти. Встроенный просмотр этого формата пока не поддерживается.</Text>}
    {active && loading ? <Text style={{ color: t.muted }}>Подготавливаю защищённый просмотр…</Text> : null}
    {active && uri && !loading ? kind === "image" ? <Image accessibilityLabel={"Просмотр изображения " + attachment.name}
      source={{ uri }} resizeMode="contain" onError={() => setError("Не удалось показать изображение. Оригинал сохранён.")}
      style={{ width: "100%", height: 280, borderRadius: nebulaRadii.field }} />
      : kind === "audio" ? <AudioPreview uri={uri} onError={setError} />
      : kind === "video" ? <VideoPreview uri={uri} onError={setError} /> : null : null}
    {active && error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
  </View>;
}
