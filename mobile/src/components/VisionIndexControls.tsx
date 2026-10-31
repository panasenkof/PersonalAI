import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch, nebulaTypography } from "../design/nebula/tokens";
import { indexPhotoPage83, type PhotoIndexPageResult } from "../media/vision-index-pages";
import { onLocalMemorySessionChange } from "../local-memory/storage";

/** User-invoked photo-index pass in the EXISTING profile/SQLCipher.
 * No background job, duplicate DB or automatic scan on app startup.
 * Each pass handles at most 4 photos and checks AppLock/model revision.
 */
export function VisionIndexControls({ activeModel }: { activeModel: boolean }) {
  const profile = useProfile();
  const t = useTheme();
  const controller = useRef<AbortController | null>(null);
  const cursor = useRef("");
  const [busy, setBusy] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [indexed, setIndexed] = useState(0);
  const [already, setAlready] = useState(0);
  const [message, setMessage] = useState("");
  const [hasMore, setHasMore] = useState(false);
  useEffect(() => {
    cursor.current = "";
    setProcessed(0); setIndexed(0); setAlready(0);
    setMessage(""); setHasMore(false);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [profile, activeModel]);
  useEffect(() => onLocalMemorySessionChange(unlocked => {
    if (!unlocked) {
      controller.current?.abort();
      setMessage("Индексация остановлена: память заблокирована.");
    }
  }), []);

  async function start() {
    if (busy || !activeModel) return;
    const signal = new AbortController();
    controller.current = signal;
    setBusy(true); setMessage("");
    let count = 0;
    try {
      // Bounded foreground pass: at most 200 attachments per button press.
      // Continue uses in-memory cursor; reopening the screen safely restarts
      // at the beginning and skips current vector/source pairs.
      while (!signal.signal.aborted && count < 200) {
        const page: PhotoIndexPageResult = await indexPhotoPage83(profile, {
          afterId: cursor.current, limit: 2, signal: signal.signal,
        });
        count += page.examined;
        setProcessed(n => n + page.examined);
        setIndexed(n => n + page.indexed);
        setAlready(n => n + page.alreadyCurrent);
        setHasMore(page.hasMore);
        if (page.halted !== "none") {
          const cause: Record<string, string> = {
            model_not_installed: "Выбранная модель недоступна — проверьте её загрузку.",
            model_changed: "Модель изменилась — начните проверку сначала.",
            failed: "Ошибка обработки фотографии. Повторите после проверки модели и файла.",
          };
          if (page.halted === "model_changed") {
            cursor.current = "";
            setHasMore(true);
          }
          setMessage(cause[page.halted] ?? "Индексация остановлена.");
          break;
        }
        if (!page.examined || page.nextCursor === cursor.current) {
          setMessage("Новых фотографий для обработки нет.");
          break;
        }
        cursor.current = page.nextCursor;
        if (!page.hasMore) {
          setMessage("Проверка фотографий завершена.");
          break;
        }
      }
      if (count >= 200 && !signal.signal.aborted) {
        setMessage("Проверено 200 файлов. Нажмите «Продолжить», чтобы обработать следующие.");
      }
    } catch (e) {
      setMessage(signal.signal.aborted ? "Индексация остановлена." :
        e instanceof Error && e.message === "application_locked"
          ? "Индексация остановлена: память заблокирована."
          : "Не удалось проиндексировать фотографии. Проверьте модель и доступ к памяти.");
    } finally {
      if (controller.current === signal) controller.current = null;
      setBusy(false);
    }
  }
  const btn = {
    minHeight: nebulaTouch.minimum, borderWidth: 1, borderColor: t.line,
    borderRadius: nebulaRadii.field, paddingHorizontal: nebulaSpacing.md,
    backgroundColor: t.panel, alignItems: "center" as const,
    justifyContent: "center" as const,
  };
  return <View style={{ gap: nebulaSpacing.sm, marginTop: nebulaSpacing.sm }}>
    <Text style={{ color: t.text, fontWeight: "700" }}>Фотографии в памяти</Text>
    <Text style={{ color: t.muted, ...nebulaTypography.label }}>
      По вашему запросу проверить сохранённые изображения и вычислить недостающие эмбеддинги на телефоне.
      Оригиналы и текстовый поиск MiniLM не изменяются. Можно остановить в любой момент.
    </Text>
    <Pressable accessibilityRole="button" accessibilityLabel={busy ? "Остановить индексацию фотографий" :
      "Индексировать фотографии"} disabled={!activeModel}
      onPress={() => busy ? controller.current?.abort() : void start()}
      style={{ ...btn, opacity: activeModel ? 1 : 0.5 }}>
      <Text style={{ color: t.secondary, fontWeight: "600" }}>
        {busy ? "Остановить индексацию" : hasMore ? "Продолжить индексацию" : "Индексировать фотографии"}
      </Text>
    </Pressable>
    {busy ? <ActivityIndicator accessibilityLabel="Индексация фотографий выполняется" /> : null}
    {(processed > 0 || message) ? <Text accessibilityLiveRegion="polite"
      style={{ color: t.muted, ...nebulaTypography.label }}>
      Проверено: {processed} · Новых: {indexed} · Уже готовы: {already}
      {message ? "\n" + message : ""}
    </Text> : null}
  </View>;
}
