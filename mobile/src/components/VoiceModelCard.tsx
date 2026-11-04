import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { WHISPER_CHOICES } from "../media/whisper-core";
import type { WhisperId } from "../media/whisper-core";
import { cancelWhisperDownload, deleteWhisper, downloadWhisper, useWhisperStatus } from "../media/whisper";
import { grantOnlineSpeechConsent, hasOnlineSpeechConsent, resolveVoiceEngine, setVoiceEngine, useVoiceEngine } from "../media/voice-engine";
import { useTheme } from "../theme";
import { Collapsible } from "./Collapsible";
import { NebulaConfirmSheet } from "./NebulaConfirmSheet";
import { NebulaAction } from "../design/nebula/components";

/** Dictation engine choice and independently managed on-device Whisper model. */
export function VoiceModelCard({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const t = useTheme();
  const status = useWhisperStatus();
  const voice = useVoiceEngine();
  // The choice being saved is shown immediately; Whisper settings appear only for Whisper.
  const selected = voice.pending ?? resolveVoiceEngine(voice.preference, status.state === "ready");
  const googleOnAndroid = Platform.OS === "android";
  const systemLabel = googleOnAndroid ? "Google — системное окно" : "Системное распознавание";
  const [choice, setChoice] = useState<WhisperId>("base");
  const [googleConsent, setGoogleConsent] = useState<boolean | null>(null);
  const [notice, setNotice] = useState("");
  const [approval, setApproval] = useState<
    { kind: "google" } | { kind: "download"; id: WhisperId; name: string; approxMb: number } |
    { kind: "delete"; id: WhisperId; name: string } | null
  >(null);
  const intent = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void hasOnlineSpeechConsent().then(allowed => { if (mounted.current) setGoogleConsent(allowed); });
    return () => { mounted.current = false; intent.current++; };
  }, []);
  const selectEngine = async (engine: "system" | "whisper") => {
    const request = ++intent.current;
    setApproval(null); setNotice("");
    if (engine === "whisper") {
      void setVoiceEngine("whisper").catch(() => { if (mounted.current && request === intent.current) setNotice("Не удалось сохранить выбор. Повторите."); });
      return;
    }
    try {
      const permitted = await hasOnlineSpeechConsent();
      if (!mounted.current || request !== intent.current) return;
      if (permitted) {
        void setVoiceEngine("system").catch(() => { if (mounted.current && request === intent.current) setNotice("Не удалось сохранить выбор. Повторите."); });
      } else setApproval({ kind: "google" });
    } catch {
      if (mounted.current && request === intent.current) setNotice("Не удалось проверить согласие на передачу речи. Повторите выбор.");
    }
  };
  const current = status.state === "ready" || status.state === "downloading" ? status.id : undefined;
  const picked = WHISPER_CHOICES.find(c => c.id === choice)!;
  const button = (primary: boolean) => ({ minHeight: 46, paddingHorizontal: 16, justifyContent: "center" as const, alignItems: "center" as const,
    borderRadius: 16, borderWidth: 1, borderColor: t.accent, backgroundColor: primary ? t.accent : t.panel });
  const askDownload = () => {
    if (status.state === "unsupported" || status.state === "downloading" || !voice.loaded || voice.saving || current === choice) return;
    setApproval({ kind: "download", id: picked.id, name: picked.name, approxMb: picked.approxMb });
  };
  const askDelete = () => {
    if (status.state !== "ready") return;
    const model = WHISPER_CHOICES.find(c => c.id === status.id);
    if (model) setApproval({ kind: "delete", id: model.id, name: model.name });
  };
  const confirmAction = () => {
    const request = approval;
    setApproval(null);
    if (!request) return;
    if (request.kind === "google") {
      const decision = ++intent.current;
      void grantOnlineSpeechConsent().then(() => {
        if (!mounted.current || intent.current !== decision) return;
        setGoogleConsent(true);
        return setVoiceEngine("system");
      }).catch(() => {
        if (mounted.current && intent.current === decision) setNotice("Не удалось сохранить разрешение. Попробуйте ещё раз.");
      });
      return;
    }
    if (!voice.loaded || voice.saving || status.state === "downloading" || status.state === "unsupported") return;
    if (request.kind === "download") {
      const model = WHISPER_CHOICES.find(c => c.id === request.id);
      if (model?.name === request.name && model?.approxMb === request.approxMb &&
          choice === request.id && !(status.state === "ready" && status.id === request.id)) {
        void downloadWhisper(request.id);
      }
    } else if (status.state === "ready" && status.id === request.id &&
        WHISPER_CHOICES.some(c => c.id === request.id && c.name === request.name)) {
      void deleteWhisper();
    }
  };

  const summary = (selected === "whisper" ? "Whisper на телефоне" : googleOnAndroid ? "Google · системное окно · через интернет" : "Системное распознавание · через интернет") +
    (status.state === "ready" ? " · модель " + (WHISPER_CHOICES.find(c => c.id === status.id)?.name || "") + " скачана" : status.state === "downloading" ? ` · скачивается ${status.progress}%` : "");
  return <><Collapsible icon="mic" id="settings.voice" title="Голосовой ввод" summary={summary} defaultOpen={defaultOpen} forceOpen={defaultOpen}>
    <Text style={{ color: t.muted, lineHeight: 20 }}>Выберите способ диктовки для чата и заметок. Выбор сохраняется; скачанную модель Whisper можно использовать снова в любой момент.</Text>
    <View accessibilityRole="radiogroup" accessibilityLabel="Способ распознавания речи" style={{ gap: 8 }}>
      {([
        { id: "system", name: systemLabel, detail: googleOnAndroid ? "При нажатии микрофона сразу открывается системное окно распознавания Android. Через интернет; разрешение подтверждается здесь один раз." : "Распознавание через системную службу. Разрешение на обработку речи через интернет подтверждается здесь один раз." },
        { id: "whisper", name: "Whisper на телефоне", detail: "Без интернета. Нужна скачанная модель ниже." },
      ] as const).map(option => {
        const checked = voice.loaded && selected === option.id;
        const unavailable = option.id === "whisper" && status.state === "unsupported";
        const disabled = !voice.loaded || voice.saving || unavailable;
        return <Pressable key={option.id} accessibilityRole="radio" accessibilityLabel={option.name} aria-checked={checked} accessibilityState={{ disabled }} disabled={disabled}
          onPress={() => { void selectEngine(option.id); }}
          style={{ minHeight: 56, padding: 12, gap: 4, borderRadius: 14, borderWidth: 1, borderColor: checked ? t.accent : t.line, backgroundColor: checked ? t.soft : t.panel, opacity: unavailable ? 0.5 : 1 }}>
          <Text style={{ color: checked ? t.secondary : t.text, fontWeight: "600" }}>{checked ? "● " : "○ "}{option.name}</Text>
          <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{option.detail}</Text>
        </Pressable>;
      })}
    </View>
    {!voice.loaded ? <Text style={{ color: t.muted }}>Загружаю настройки голоса…</Text> : null}
    {voice.error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{voice.error}</Text> : null}
    {notice ? <Text accessibilityRole="alert" style={{ color: t.err }}>{notice}</Text> : null}
    {voice.loaded && selected === "system" && googleConsent === false ?
      <Text style={{ color: t.secondary }}>Для первого запуска нажмите «{systemLabel}» и разрешите онлайн-распознавание. В чате дополнительных вопросов не будет.</Text> : null}
    {voice.loaded && !voice.error && selected === "whisper" && status.state !== "ready" && status.state !== "unsupported" ?
      <Text style={{ color: t.secondary }}>Для диктовки Whisper скачайте модель ниже или дождитесь завершения скачивания.</Text> : null}
    {selected === "system" && status.state === "downloading" ? <Text style={{ color: t.muted }}>Модель Whisper скачивается в фоне: {status.progress}%.</Text> : null}
    {voice.loaded && selected === "whisper" ? <>
    <Text style={{ color: t.text, fontSize: 16, fontWeight: "700", marginTop: 6 }}>Голос без интернета</Text>
    {status.state === "unsupported" ? <Text style={{ color: t.muted, lineHeight: 20 }}>Распознавание речи на самом телефоне требует Android 13 или новее (iOS 17). На этом телефоне голосовой ввод работает через системную службу.</Text> : <>
      <Text style={{ color: t.muted, lineHeight: 20 }}>Модель Whisper распознаёт русскую речь прямо на телефоне — без Google и без интернета. Скачивается один раз.</Text>
      {status.state === "ready" ? <Text style={{ color: t.ok }}>Скачано: {WHISPER_CHOICES.find(c => c.id === status.id)?.name}.</Text> : null}
      {status.state === "error" ? <Text selectable accessibilityRole="alert" style={{ color: t.err }}>{status.message}</Text> : null}
      {status.state === "downloading" ? <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><ActivityIndicator />
          <Text style={{ color: t.text }}>Скачивается {WHISPER_CHOICES.find(c => c.id === status.id)?.name}: {status.progress}%</Text></View>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: t.soft, overflow: "hidden" }}><View style={{ width: `${status.progress}%`, height: 6, backgroundColor: t.accent }} /></View>
        <NebulaAction icon="x" label="Отменить скачивание" accessibilityLabel="Отменить скачивание модели" onPress={cancelWhisperDownload} />
      </View> : <>
        <View style={{ gap: 6 }}>
          {WHISPER_CHOICES.map(c => <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={"Модель " + c.name} accessibilityState={{ selected: choice === c.id }}
            onPress={() => setChoice(c.id)} style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ color: choice === c.id ? t.secondary : t.text }}>{choice === c.id ? "● " : "○ "}{c.name} · около {c.approxMb} МБ{current === c.id ? " · скачана" : ""}</Text>
            <Text style={{ color: t.muted, fontSize: 12, marginLeft: 18 }}>{c.hint}</Text>
          </Pressable>)}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {current !== choice ? <NebulaAction icon="download" accessibilityLabel="Скачать модель распознавания"
            label={current ? "Заменить на " + picked.name : "Скачать " + picked.name}
            variant="primary" onPress={askDownload} /> : null}
          {status.state === "ready" ? <NebulaAction icon="trash-2" label="Удалить модель"
            accessibilityLabel="Удалить модель распознавания" variant="danger" onPress={askDelete} /> : null}
        </View>
      </>}
    </>}
    </> : null}
  </Collapsible>
    <NebulaConfirmSheet visible={approval !== null}
      title={approval?.kind === "google" ? (googleOnAndroid ? "Распознавание Google" : "Системное распознавание") :
        approval?.kind === "delete" ? "Удалить модель распознавания?" : "Скачать модель Whisper?"}
      message={approval?.kind === "google"
        ? (googleOnAndroid
          ? "Откроется системное окно распознавания Android. Речь может передаваться Google через интернет. Разрешить этот способ ввода?"
          : "Речь может передаваться системной службе через интернет. Разрешить этот способ ввода?")
        : approval?.kind === "delete"
          ? `«${approval.name}» будет удалена с телефона. Чтобы диктовать без модели, выберите системное распознавание.`
          : `«${approval?.name || ""}», около ${approval?.kind === "download" ? approval.approxMb : 0} МБ. Лучше использовать Wi-Fi. Модель хранится локально; речь никуда не отправляется.`}
      confirmLabel={approval?.kind === "google" ? "Разрешить онлайн-распознавание" :
        approval?.kind === "delete" ? "Удалить модель" : "Скачать модель"}
      cancelLabel="Отмена" danger={approval?.kind === "delete"}
      disabled={voice.saving || (approval?.kind !== "google" && status.state === "downloading")}
      onCancel={() => setApproval(null)} onConfirm={confirmAction} />
    </>;
}
