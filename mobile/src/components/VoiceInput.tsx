import { useFocusEffect } from "@react-navigation/native";
import { ExpoSpeechRecognitionModule as Speech, useSpeechRecognitionEvent } from "expo-speech-recognition";
import Feather from "@expo/vector-icons/Feather";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Platform, Pressable, Text, View } from "react-native";
import { nativeInteractionActive, withNativeInteraction } from "../security/native-interaction";
import type { ServiceChoice } from "../media/voice";
import { NO_SERVICE_MESSAGE, START_TIMEOUT_MS, pickRecognitionService, startTimeoutMessage, voiceErrorMessage } from "../media/voice";
import { startWhisperDictation, useWhisperStatus } from "../media/whisper";
import type { DictationSession } from "../media/whisper";
import { resolveVoiceEngine, useVoiceEngine } from "../media/voice-engine";
import { useTheme } from "../theme";
import { IconAction } from "./IconAction";

let networkConsent = false;
const FINAL_RESULT_TIMEOUT_MS = 12_000;
function recognitionService(): ServiceChoice | undefined {
  if (Platform.OS !== "android") return undefined;
  try {
    return pickRecognitionService(Speech.getSpeechRecognitionServices?.() ?? [], Speech.getDefaultRecognitionService?.()?.packageName ?? "");
  } catch { return undefined; }
}

/** Each mounted input owns one draft. Unmounting (including clearing the draft
 * or changing conversations) invalidates permission requests and late results. */
export function VoiceInput({ value, onChange, disabled = false, onError, showLabel = false, onBegin, onActiveChange, onPhaseChange }: {
  value: string; onChange: (text: string) => void; disabled?: boolean; onError: (message: string) => void; showLabel?: boolean;
  onBegin?: () => void; onActiveChange?: (active: boolean) => void;
  /** Real native recognizer stage for the decorative Home orb. */
  onPhaseChange?: (phase: "idle" | "starting" | "listening" | "finishing") => void;
}) {
  const t = useTheme();
  const whisper = useWhisperStatus();
  const voice = useVoiceEngine();
  const selectedEngine = resolveVoiceEngine(voice.preference, whisper.state === "ready");
  const session = useRef<DictationSession | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const viaWhisper = useRef(false);
  const owns = useRef(false);
  const starting = useRef(false);
  const started = useRef(false);
  const finishing = useRef(false);
  const base = useRef("");
  const offline = useRef(true);
  const service = useRef<ServiceChoice | undefined>(undefined);
  const [offerNetwork, setOfferNetwork] = useState(false);
  const [phase, setPhase] = useState<"idle" | "starting" | "listening" | "finishing">("idle");
  useEffect(() => { onActiveChange?.(phase !== "idle"); onPhaseChange?.(phase); }, [phase, onActiveChange, onPhaseChange]);
  useEffect(() => () => { onActiveChange?.(false); onPhaseChange?.("idle"); }, [onActiveChange, onPhaseChange]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = () => {
    if (timer.current) clearTimeout(timer.current);
    if (watchdog.current) clearTimeout(watchdog.current);
    if (finalTimer.current) clearTimeout(finalTimer.current);
    timer.current = watchdog.current = finalTimer.current = null;
  };
  const report = (message: string) => onError(message + (whisper.state === "absent" || whisper.state === "error" ?
    " Или скачайте распознавание на телефон: Настройки → Голосовой ввод → Голос без интернета." : ""));
  const stop = useCallback(() => {
    generation.current++;
    clearTimers();
    const wasOwner = owns.current;
    const wasWhisper = viaWhisper.current;
    owns.current = viaWhisper.current = starting.current = started.current = finishing.current = false;
    controller.current?.abort(); controller.current = null;
    if (wasWhisper) void session.current?.stop();
    else if (wasOwner) try { Speech.abort(); } catch { /* already stopped */ }
    session.current = null; setPhase("idle");
  }, []);
  const markFinishing = () => {
    if (!owns.current || finishing.current) return false;
    finishing.current = true; setPhase("finishing"); clearTimers();
    finalTimer.current = setTimeout(() => {
      if (!owns.current) return;
      report("Голосовой ввод: распознавание последней фразы заняло слишком долго. Уже распознанный текст сохранён; повторите ввод оставшейся части.");
      stop();
    }, FINAL_RESULT_TIMEOUT_MS);
    return true;
  };
  const finish = () => {
    if (!markFinishing()) return;
    try { if (viaWhisper.current) void session.current?.stop(); else Speech.stop(); }
    catch (e) { report((e as Error).message || "Не удалось завершить диктовку."); stop(); }
  };
  useSpeechRecognitionEvent("start", () => {
    if (!owns.current || viaWhisper.current) return;
    started.current = true; setPhase("listening");
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = null;
  });
  useSpeechRecognitionEvent("speechend", () => {
    // Non-continuous system recognition owns endpointing and finalization.
    // Calling stop again here can discard its pending final result.
    if (owns.current && !viaWhisper.current) markFinishing();
  });
  useSpeechRecognitionEvent("result", event => {
    if (!owns.current || viaWhisper.current || AppState.currentState !== "active") return;
    const transcript = event.results[0]?.transcript || "";
    if (transcript) onChange((base.current + (base.current ? " " : "") + transcript).slice(0, 4000));
    if (event.isFinal) markFinishing();
  });
  useSpeechRecognitionEvent("end", () => {
    if (!owns.current || viaWhisper.current) return;
    owns.current = starting.current = started.current = finishing.current = false;
    clearTimers(); setPhase("idle");
  });
  useSpeechRecognitionEvent("error", event => {
    if (!owns.current || viaWhisper.current) return;
    if (offline.current && !["aborted", "not-allowed", "no-speech", "speech-timeout"].includes(event.error)) setOfferNetwork(true);
    if (event.error !== "aborted") report(voiceErrorMessage(event.error, event.message, service.current));
    stop();
  });
  useFocusEffect(useCallback(() => stop, [stop]));
  useEffect(() => {
    const sub = AppState.addEventListener("change", state => { if (state === "background" && !nativeInteractionActive()) stop(); });
    return () => { sub.remove(); stop(); };
  }, [stop]);
  useEffect(() => { if (disabled) stop(); }, [disabled, stop]);
  useEffect(() => { setOfferNetwork(false); return stop; }, [voice.preference, stop]);

  async function startWhisper(token: number) {
    const aborter = new AbortController(); controller.current = aborter;
    base.current = value.trim(); owns.current = viaWhisper.current = true;
    try {
      const running = await withNativeInteraction(() => startWhisperDictation(
        text => { if (generation.current === token && viaWhisper.current && AppState.currentState === "active" && text) onChange((base.current + (base.current ? " " : "") + text).slice(0, 4000)); },
        message => { if (generation.current === token && owns.current) onError(message); },
        () => {
          if (generation.current !== token || !viaWhisper.current) return;
          viaWhisper.current = owns.current = starting.current = finishing.current = false;
          session.current = null; controller.current = null; clearTimers(); setPhase("idle");
        }, { signal: aborter.signal, onFinishing: () => { if (generation.current === token) markFinishing(); } }));
      if (generation.current !== token || !viaWhisper.current) { void running.stop(); return; }
      session.current = running;
      if (!finishing.current) setPhase("listening");
    } catch (e) {
      if (generation.current === token && !aborter.signal.aborted) { onError((e as Error).message || "Голос на телефоне: не удалось начать диктовку."); stop(); }
    } finally { if (generation.current === token) starting.current = false; }
  }
  async function start(network = false) {
    if (disabled || !voice.loaded || voice.saving || owns.current || starting.current) return;
    if (voice.error) { onError(voice.error); return; }
    if (selectedEngine === "whisper" && !network && whisper.state !== "ready") {
      onError(whisper.state === "unsupported" ? "Whisper недоступен на этом телефоне. Выберите системное распознавание: Настройки → Голосовой ввод." :
        whisper.state === "downloading" ? `Модель Whisper ещё скачивается (${whisper.progress}%). Дождитесь завершения или выберите системное распознавание в настройках.` :
        "Выбран Whisper. Скачайте модель: Настройки → Голосовой ввод → Голос без интернета. Или выберите системное распознавание.");
      return;
    }
    onBegin?.();
    const token = ++generation.current;
    starting.current = true; setPhase("starting");
    if (selectedEngine === "whisper" && !network) return startWhisper(token);
    try {
      if (!Speech.isRecognitionAvailable()) throw new Error(NO_SERVICE_MESSAGE);
      const useNetwork = network || networkConsent || !Speech.supportsOnDeviceRecognition();
      if (useNetwork && !network && !networkConsent) {
        starting.current = false; setPhase("idle");
        Alert.alert("Голосовой ввод", "Распознавание без интернета на этом телефоне недоступно. Системная служба телефона (обычно Google) может отправлять речь своему серверу; регистрация в PersAI не нужна.", [
          { text: "Отмена", style: "cancel" },
          { text: "Использовать системную службу", onPress: () => { if (generation.current !== token) return; networkConsent = true; void start(true); } },
        ]); return;
      }
      const permission = await withNativeInteraction(() => Speech.requestPermissionsAsync());
      if (generation.current !== token) return;
      if (!permission.granted) throw new Error("Голосовой ввод: нет разрешения на микрофон. Разрешите микрофон для PersAI в настройках телефона.");
      service.current = recognitionService();
      base.current = value.trim(); offline.current = !useNetwork; setOfferNetwork(false);
      owns.current = true; started.current = finishing.current = false;
      // Native endpointing remains authoritative. Android documents that
      // custom silence extras may be ignored or cause unexpected results.
      Speech.start({
        lang: "ru-RU", interimResults: true, continuous: false, requiresOnDeviceRecognition: !useNetwork, addsPunctuation: true,
        ...(service.current?.pkg ? { androidRecognitionServicePackage: service.current.pkg } : {}),
      });
      if (!owns.current) return;
      if (!started.current) watchdog.current = setTimeout(() => {
        if (owns.current && !started.current) { report(startTimeoutMessage(service.current)); stop(); }
      }, START_TIMEOUT_MS);
      if (!finishing.current) timer.current = setTimeout(finish, 60_000);
    } catch (e) { if (generation.current === token) { report((e as Error).message || "Голосовой ввод: не удалось начать распознавание."); stop(); } }
    finally { if (generation.current === token) starting.current = false; }
  }
  const offerConsent = () => {
    const token = generation.current;
    Alert.alert("Системная диктовка", "Служба телефона может отправлять речь своему серверу. Разрешить её?",
      [{ text: "Отмена", style: "cancel" }, { text: "Разрешить", onPress: () => { if (generation.current !== token) return; networkConsent = true; void start(true); } }]);
  };
  const active = phase !== "idle";
  // While the model loads or the last phrase is decoded, the button cancels:
  // the user is never locked out. Text already in the draft stays there.
  const waiting = phase === "starting" || phase === "finishing";
  const press = () => waiting ? stop() : active ? finish() : void start();
  const label = phase === "starting" ? "Отмена" : phase === "finishing" ? "Прервать" : active ? "Стоп" : "Голос";
  const accessibilityLabel = phase === "starting" ? "Отменить подготовку диктовки" : phase === "finishing" ? "Прервать распознавание последней фразы" : active ? "Остановить диктовку" : "Голосовой ввод";
  return <View style={{ zIndex: 1 }}>
    {showLabel ? <IconAction icon={active ? "square" : "mic"} label={label} accessibilityLabel={accessibilityLabel}
      hint={phase === "starting" ? "Отменить запуск диктовки." : phase === "finishing" ? "Не ждать последнюю фразу: уже распознанный текст останется." : active ? "Диктовка завершится после паузы в речи. Можно закончить раньше кнопкой «Стоп»." : (selectedEngine === "whisper" ? "Whisper на телефоне. " : "Системное распознавание. ") + "Надиктовать сообщение. Ввод завершится после паузы, отправка — отдельной кнопкой."}
      disabled={disabled || !voice.loaded || voice.saving} emphasized={active} hintAbove hintAlign="start" onPress={press} /> : <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel}
      disabled={disabled || !voice.loaded || voice.saving} onPress={press}
      style={{ minWidth: 46, minHeight: 46, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: active ? t.accent : t.soft }}>
      <Feather name={active ? "square" : "mic"} size={21} color={active ? "#fff" : t.accent} />
    </Pressable>}
    {offerNetwork && !active && !networkConsent ? <Pressable accessibilityRole="button" accessibilityLabel="Использовать системную диктовку" disabled={disabled} style={{ minHeight: 44, width: 46, justifyContent: "center" }} onPress={offerConsent}><Text style={{ color: t.accent, fontSize: 10, textAlign: "center" }}>Через сервис</Text></Pressable> : null}
    {active ? <Text accessibilityLiveRegion="polite" style={{ color: t.accent, fontSize: 10, textAlign: "center" }}>{phase === "starting" ? "Готовлю микрофон" : phase === "finishing" ? "Распознаю…" : "Слушаю…"}</Text> : null}
  </View>;
}
