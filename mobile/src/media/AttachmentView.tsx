import { memoryErrorMessage } from "../local-memory/errors";
import React, { useEffect, useState } from "react";
import Feather from "@expo/vector-icons/Feather";
import { Image, Pressable, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { File } from "expo-file-system";
import { useVideoPlayer, VideoView } from "expo-video";
import { useApplicationVisible } from "../security/visibility";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";
import { NebulaAction } from "../design/nebula/components";
import { attachmentsForEntity, materializeAttachment } from "./attachments";
import { localExtractionEvidence } from "../local-memory/extractions";
import { renderPdfPage, deletePdfPagePreview } from "./pdf-page-preview";
import type { ExtractionEvidence } from "../local-memory/extractions";
import type { Attachment } from "./attachments";
import type { VerifiedOriginalLocator } from "../local-memory/types";
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
    return () => { try { player.pause(); } catch { /* Native object already released. */ } finally { sub.remove(); } };
  }, [player, onError]);
  return <VideoView player={player} nativeControls style={{ width: "100%", height: 230 }} allowsPictureInPicture={false} />;
}

/** One real original page at a time. Image data stays in a temporary app cache;
 * changing page, closing, backgrounding or locking deletes the raster. */
function PdfOriginalPages({ uri }: { uri: string }) {
  const t = useTheme();
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [imageUri, setImageUri] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { setPage(1); setPageCount(null); }, [uri]);
  useEffect(() => {
    let alive = true;
    let temporary = "";
    const controller = new AbortController();
    setImageUri(""); setError(""); setLoading(true);
    void renderPdfPage(uri, page, controller.signal)
      .then(result => {
        temporary = result.uri;
        if (alive && !controller.signal.aborted) {
          setPageCount(result.pageCount);
          setImageUri(result.uri);
        } else void deletePdfPagePreview(result.uri);
      })
      .catch(e => { if (alive && !controller.signal.aborted) setError(e instanceof Error ? e.message : "Не удалось показать страницу PDF."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => {
      alive = false;
      controller.abort();
      if (temporary) void deletePdfPagePreview(temporary);
    };
  }, [uri, page, attempt]);

  return <View style={{ gap: nebulaSpacing.sm }}>
    <Text style={{ color: t.muted }}>
      Страница оригинального PDF · локальный просмотр без распознавания. Сканы видны, но текст на них пока не найден поиском.
    </Text>
    {loading ? <Text accessibilityLiveRegion="polite" style={{ color: t.muted }}>Открываю страницу {page}…</Text> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
    {error ? <NebulaAction icon="refresh-cw" label="Повторить просмотр"
      accessibilityLabel="Повторить просмотр страницы PDF"
      onPress={() => setAttempt(v => v + 1)} /> : null}
    {imageUri && !loading && !error ? <Image source={{ uri: imageUri }}
      accessibilityLabel={"Исходная страница PDF " + page} resizeMode="contain"
      onError={() => setError("Не удалось показать страницу PDF. Оригинал сохранён.")}
      style={{ width: "100%", height: 390, borderRadius: nebulaRadii.field }} /> : null}
    {pageCount !== null ? <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <NebulaAction icon="chevron-left" label="Назад" accessibilityLabel="Предыдущая страница PDF"
        disabled={page <= 1 || loading} onPress={() => setPage(p => Math.max(1, p - 1))} />
      <Text style={{ color: t.text, fontWeight: "700" }}>Страница {page} из {pageCount}</Text>
      <NebulaAction icon="chevron-right" label="Далее" accessibilityLabel="Следующая страница PDF"
        disabled={page >= pageCount || loading} onPress={() => setPage(p => Math.min(pageCount, p + 1))} />
    </View> : null}
  </View>;
}

/** Source-bound, local SQLCipher evidence only. The original remains encrypted;
 * system PDF rendering and exact page jumping are not claimed by this screen.
 * The parent performs the existing version/ACL-aware materialization first.
 */
function PdfTextPreview({ profile, attachment, ready }: {
  profile: string; attachment: Attachment; ready: boolean;
}) {
  const t = useTheme();
  const [run, setRun] = useState<ExtractionEvidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setRun(null); setError(""); setLoading(ready);
    if (ready) {
      void localExtractionEvidence(profile, attachment.entity_id, attachment.id, 10)
        .then(runs => {
          if (alive) setRun(runs.find(item =>
            item.producerKind === "pdf" && item.segments.some(seg => seg.location.kind === "page")) || null);
        })
        .catch(e => { if (alive) setError(memoryErrorMessage(e)); })
        .finally(() => { if (alive) setLoading(false); });
    }
    return () => { alive = false; };
  }, [profile, attachment.entity_id, attachment.id, ready]);

  const pages = new Map<number, string[]>();
  for (const segment of run?.segments || []) {
    if (segment.location.kind !== "page") continue;
    const page = segment.location.page;
    pages.set(page, [...(pages.get(page) || []), segment.text]);
  }
  return <View style={{ gap: nebulaSpacing.sm }}>
    <Text style={{ color: t.muted }}>
      Оригинал PDF сохранён зашифрованным. Ниже — только ранее извлечённый текст; изображения и страницы без текстового слоя не отображаются. Переход из результата поиска к конкретной исходной странице пока недоступен.
    </Text>
    {loading ? <Text style={{ color: t.muted }}>Загружаю текст документа…</Text> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
    {!loading && !error && !pages.size ? <Text style={{ color: t.muted }}>
      Постраничный текст не сохранён. Оригинал доступен в зашифрованной памяти; извлечение текста можно выполнить при новом импорте.
    </Text> : null}
    {[...pages].map(([page, texts]) => <View key={page} style={{ gap: 4, paddingVertical: 8, borderTopWidth: 1, borderTopColor: t.line }}>
      <Text accessibilityRole="header" style={{ color: t.secondary, fontWeight: "700" }}>Страница {page} · текстовый слой</Text>
      <Text selectable style={{ color: t.text, lineHeight: 21 }}>{texts.join("")}</Text>
    </View>)}
  </View>;
}

/** Audio is decrypted only after opening this original. Previously saved ASR
 * evidence is read through the same profile/source-version-aware reader as PDF.
 * Only producer-reported, valid time positions can seek the native player.
 */
function AudioPreview({ uri, profile, attachment, onError }: {
  uri: string; profile: string; attachment: Attachment; onError: (message: string) => void;
}) {
  const t = useTheme();
  const player = useVideoPlayer(uri);
  const [playing, setPlaying] = useState(false);
  const [transcript, setTranscript] = useState<ExtractionEvidence | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(true);
  const [transcriptError, setTranscriptError] = useState("");
  const [showAllSegments, setShowAllSegments] = useState(false);

  useEffect(() => {
    const status = player.addListener("statusChange", event => {
      if (event.status === "error") onError("Не удалось воспроизвести аудио. Оригинал сохранён.");
    });
    const playback = player.addListener("playingChange", event => setPlaying(event.isPlaying));
    return () => { try { player.pause(); } catch { /* Native object already released. */ } finally { status.remove(); playback.remove(); } };
  }, [player, onError]);

  useEffect(() => {
    let alive = true;
    setTranscript(null); setTranscriptError(""); setTranscriptLoading(true); setShowAllSegments(false);
    void localExtractionEvidence(profile, attachment.entity_id, attachment.id, 10)
      .then(runs => {
        if (alive) setTranscript(runs.find(run =>
          run.producerKind === "asr" && (run.status === "complete" || run.status === "partial") &&
          run.segments.length > 0) || null);
      })
      .catch(error => { if (alive) setTranscriptError(memoryErrorMessage(error)); })
      .finally(() => { if (alive) setTranscriptLoading(false); });
    return () => { alive = false; };
  }, [uri, profile, attachment.entity_id, attachment.id]);

  function seekTo(startMs: number) {
    try {
      const seconds = startMs / 1000;
      if (Number.isFinite(player.duration) && player.duration > 0 && seconds > player.duration + 0.5) {
        setTranscriptError("Временная отметка выходит за пределы записи.");
        return;
      }
      player.currentTime = seconds;
      player.play();
    } catch {
      onError("Не удалось перейти к фрагменту аудио. Оригинал сохранён.");
    }
  }

  const segments = (transcript?.segments || []).filter(seg => typeof seg.text === "string" && Boolean(seg.text.trim()));
  const displayed = showAllSegments ? segments : segments.slice(0, 5);
  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    return (minutes >= 60 ? Math.floor(minutes / 60) + ":" + String(minutes % 60).padStart(2, "0") :
      String(minutes)) + ":" + String(seconds % 60).padStart(2, "0");
  };

  return <View style={{ gap: nebulaSpacing.md }}>
    <Pressable accessibilityRole="button" accessibilityLabel={playing ? "Приостановить аудио" : "Воспроизвести аудио"}
      onPress={() => { try { if (playing) player.pause(); else player.play(); } catch { onError("Не удалось воспроизвести аудио. Закройте просмотр и повторите."); } }}
      style={{ minHeight: nebulaTouch.minimum, justifyContent: "center", alignItems: "center", borderRadius: nebulaRadii.field, backgroundColor: t.soft }}>
      <Text style={{ color: t.secondary, fontWeight: "700" }}>{playing ? "Пауза" : "Воспроизвести"} · аудио</Text>
    </Pressable>
    <View style={{ gap: nebulaSpacing.sm }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontWeight: "700", fontSize: 16 }}>Расшифровка</Text>
      {transcriptLoading ? <Text style={{ color: t.muted }}>Загружаю сохранённый текст…</Text> : null}
      {transcriptError ? <Text accessibilityRole="alert" style={{ color: t.err }}>{transcriptError}</Text> : null}
      {!transcriptLoading && !transcriptError && !transcript ?
        <Text style={{ color: t.muted }}>Для этой записи пока нет сохранённого транскрипта. Можно распознать её при импорте.</Text> : null}
      {transcript && !transcriptLoading ? <>
        <Text style={{ color: t.muted, fontSize: 13 }}>
          {transcript.coverage === "full" ? "Текст получен при распознавании." :
            "Текст распознавания может быть неполным."} Переход доступен только для подтверждённых таймкодов.
        </Text>
        {displayed.map((segment, index) => {
          const location = segment.location;
          const startMs = location.kind === "time" &&
            Number.isSafeInteger(location.startMs) && Number.isSafeInteger(location.endMs) &&
            location.startMs >= 0 && location.endMs > location.startMs &&
            location.endMs <= 86_400_000 ? location.startMs : null;
          return startMs === null ?
            <Text key={segment.id || index} selectable style={{ color: t.text, lineHeight: 23, paddingVertical: 4 }}>
              {segment.text}
            </Text> :
            <Pressable key={segment.id || index} accessibilityRole="button"
              accessibilityLabel={"Перейти к " + formatTime(startMs) + " · " + segment.text}
              onPress={() => seekTo(startMs)}
              style={{ minHeight: nebulaTouch.minimum, padding: nebulaSpacing.sm, justifyContent: "center",
                borderRadius: nebulaRadii.field, backgroundColor: t.soft, gap: 4 }}>
              <Text style={{ color: t.secondary, fontSize: 13, fontWeight: "700" }}>{formatTime(startMs)}</Text>
              <Text style={{ color: t.text, lineHeight: 22 }}>{segment.text}</Text>
            </Pressable>;
        })}
        {segments.length > 5 ? <NebulaAction icon={showAllSegments ? "chevron-up" : "chevron-down"}
          label={showAllSegments ? "Свернуть" : "Показать все фрагменты · " + segments.length}
          accessibilityLabel={showAllSegments ? "Свернуть транскрипт" : "Показать весь транскрипт"}
          onPress={() => setShowAllSegments(value => !value)} /> : null}
      </> : null}
    </View>
  </View>;
}
export function AttachmentView({ profile, entityId, verifiedOriginal, photoAttachmentId, onRecognize, collapsedByDefault = false }: { onRecognize?: (attachment: Attachment) => void; profile: string; entityId: string; verifiedOriginal?: VerifiedOriginalLocator; photoAttachmentId?: string; collapsedByDefault?: boolean }) {
  const t = useTheme();
  const focused = useIsFocused();
  const appVisible = useApplicationVisible();
  const visible = focused && appVisible;
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [allShown, setAllShown] = useState(false);
  const [rowsExpanded, setRowsExpanded] = useState(!collapsedByDefault);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    setOpenId(null); setAllShown(false); setRowsExpanded(!collapsedByDefault); setAttachments([]); setError(""); setLoading(true);
    void attachmentsForEntity(profile, entityId)
      .then(items => { if (alive) setAttachments(items); })
      .catch(e => { if (alive) setError(memoryErrorMessage(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [profile, entityId, retry, collapsedByDefault]);

  // A search-proven source may display ONLY the original that the proof returned.
  // Missing/stale metadata never silently falls back to other note attachments.
  const scoped = verifiedOriginal ? attachments.filter(item =>
    item.id === verifiedOriginal.attachmentId &&
    item.entity_id === verifiedOriginal.recordId &&
    item.entity_id === entityId) : photoAttachmentId ? attachments.filter(item => item.id === photoAttachmentId && item.entity_id === entityId) : attachments;
  const missingVerified = Boolean((verifiedOriginal || photoAttachmentId) && !loading && !error && scoped.length !== 1);
  // A proven original always has its exact one-item scope. Ordinary notes start
  // with two compact file rows; disclosure never fetches or decrypts anything.
  const hasMore = !verifiedOriginal && !photoAttachmentId && scoped.length > 2;
  const listed = hasMore && !allShown ? scoped.slice(0, 2) : scoped;
  // Background, navigation away and app lock immediately disable all previews.
  useEffect(() => { if (!visible) setOpenId(null); }, [visible]);
  useEffect(() => { setOpenId(null); }, [verifiedOriginal?.attachmentId, verifiedOriginal?.recordVersion]);

  if (!loading && !error && scoped.length === 0 && !verifiedOriginal && !photoAttachmentId) return null;
  return <View style={{ gap: nebulaSpacing.sm }}>
    {collapsedByDefault && !missingVerified ? <Pressable testID="note-attachment-details" accessibilityRole="button"
      accessibilityLabel={rowsExpanded ? "Скрыть сведения о вложениях" : "Показать оригиналы и распознавание"}
      accessibilityState={{ expanded: rowsExpanded }} onPress={() => { setRowsExpanded(v => !v); setOpenId(null); }}
      style={{ flexDirection: "row", alignItems: "center", minHeight: nebulaTouch.minimum, gap: nebulaSpacing.sm, paddingHorizontal: nebulaSpacing.sm, borderRadius: nebulaRadii.field, backgroundColor: t.soft }}>
      <Feather name="paperclip" size={19} color={t.secondary} />
      <Text style={{ flex: 1, color: t.secondary, fontWeight: "600" }}>Оригиналы{scoped.length ? " · " + scoped.length : ""}</Text>
      <Feather name={rowsExpanded ? "chevron-up" : "chevron-down"} size={21} color={t.secondary} />
    </Pressable> : <Text accessibilityRole="header" style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>Вложения{scoped.length ? " · " + scoped.length : ""}</Text>}
    {loading ? <Text style={{ color: t.muted }}>Загружаю список вложений…</Text> : null}
    {error ? <>
      <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text>
      <NebulaAction icon="refresh-cw" label="Повторить загрузку"
        accessibilityLabel="Повторить загрузку вложений" onPress={() => setRetry(x => x + 1)} />
    </> : null}
    {missingVerified ? <Text accessibilityRole="alert" style={{ color: t.err }}>Источник изменён или недоступен. Повторите поиск.</Text> : null}
    {rowsExpanded ? listed.map(attachment => <OneAttachment key={attachment.id} onRecognize={onRecognize} profile={profile} attachment={attachment} verified={verifiedOriginal}
      expanded={visible && (openId === attachment.id || (openId === null && attachment.id === photoAttachmentId))} visible={visible}
      onToggle={() => setOpenId(id => id === attachment.id || (id === null && attachment.id === photoAttachmentId) ? "" : attachment.id)} />) : null}
    {rowsExpanded && hasMore ? <NebulaAction testID="note-attachments-expand"
      icon={allShown ? "chevron-up" : "layers"}
      label={allShown ? "Свернуть вложения" : `Показать остальные · ${scoped.length - 2}`}
      onPress={() => {
        // Closing a hidden attachment unmounts its one source-bound preview and
        // invokes the existing temporary-file cleanup.
        if (allShown) setOpenId(null);
        setAllShown(!allShown);
      }} /> : null}
  </View>;
}

function OneAttachment({ profile, attachment, expanded, visible, onToggle, verified, onRecognize }: {
  profile: string;
  attachment: Attachment;
  onRecognize?: (attachment: Attachment) => void;
  verified?: VerifiedOriginalLocator;
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
      void materializeAttachment(profile, attachment, controller.signal, verified)
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
  }, [active, attachment, profile, attempt, verified]);

  const action = kind === "image" ? "Открыть фото" : kind === "audio" ? "Прослушать аудио" : kind === "document" ? "Открыть PDF" : "Открыть видео";
  return <View style={{ padding: nebulaSpacing.md, gap: nebulaSpacing.sm, borderWidth: 1, borderColor: t.line,
    backgroundColor: t.panel, borderRadius: nebulaRadii.card }}>
    <Text style={{ color: t.text, fontWeight: "700" }} numberOfLines={3}>{attachment.name}</Text>
    <Text style={{ color: t.muted }}>{attachmentKindLabel(kind)} · {readableAttachmentSize(attachment.size)}</Text>
    {supported ? <Pressable accessibilityRole="button" accessibilityLabel={action + " " + attachment.name}
      accessibilityState={{ expanded }} onPress={() => {
        if (expanded && error) { setAttempt(n => n + 1); return; }
        onToggle();
      }} style={({ pressed }) => ({
        alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: nebulaSpacing.xs,
        minHeight: nebulaTouch.minimum, minWidth: nebulaTouch.minimum,
        paddingHorizontal: nebulaSpacing.md, borderWidth: 1, borderColor: t.line,
        borderRadius: nebulaRadii.field, backgroundColor: t.soft, opacity: pressed ? .8 : 1,
      })}>
      <Feather name={expanded ? "chevron-up" : kind === "audio" ? "play-circle" :
        kind === "image" ? "image" : kind === "document" ? "file-text" : "video"}
        color={t.secondary} size={19} />
      <Text style={{ color: t.secondary, fontWeight: "700" }}>{expanded ? error ? "Повторить просмотр" : "Закрыть просмотр" : action}</Text>
    </Pressable> : <Text style={{ color: t.muted }}>Оригинал сохранён в зашифрованной памяти. Встроенный просмотр этого формата пока не поддерживается.</Text>}
    {onRecognize ? <NebulaAction icon="refresh-cw" label="Распознать заново"
      accessibilityLabel={"Распознать заново " + attachment.name} onPress={() => onRecognize(attachment)} /> : null}
    {active && loading ? <Text style={{ color: t.muted }}>Подготавливаю защищённый просмотр…</Text> : null}
    {active && uri && !loading && !error ? kind === "image" ? <Image accessibilityLabel={"Просмотр изображения " + attachment.name}
      source={{ uri }} resizeMode="contain" onError={() => setError("Не удалось показать изображение. Оригинал сохранён.")}
      style={{ width: "100%", height: 280, borderRadius: nebulaRadii.field }} />
      : kind === "audio" ? <AudioPreview uri={uri} profile={profile} attachment={attachment} onError={setError} />
      : kind === "video" ? <VideoPreview uri={uri} onError={setError} />
      : kind === "document" ? <View style={{ gap: nebulaSpacing.md }}><PdfOriginalPages uri={uri} /><PdfTextPreview profile={profile} attachment={attachment} ready={active && Boolean(uri)} /></View> : null : null}
    {active && error ? <><Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text><Text style={{ color: t.muted }}>Для повторной попытки нажмите «Повторить просмотр».</Text></> : null}
  </View>;
}
