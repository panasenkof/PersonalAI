import { useFocusEffect } from "@react-navigation/native";
import { ExpoSpeechRecognitionModule as Speech, useSpeechRecognitionEvent } from "expo-speech-recognition";
import Feather from "@expo/vector-icons/Feather";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, Text, View } from "react-native";
import { nativeInteractionActive, withNativeInteraction } from "../security/native-interaction";
import { appendDictation, NO_SERVICE_MESSAGE, START_TIMEOUT_MS, startTimeoutMessage, voiceErrorMessage } from "../media/voice";
import { startWhisperDictation, useWhisperStatus } from "../media/whisper";
import { launchAndroidVoiceActivity } from "../media/android-voice-activity";
import type { DictationSession } from "../media/whisper";
import { hasOnlineSpeechConsent, resolveVoiceEngine, useVoiceEngine } from "../media/voice-engine";
import { useTheme } from "../theme";
import { IconAction } from "./IconAction";

const FINAL_RESULT_TIMEOUT_MS = 12_000;
/** Each mounted input owns one draft. Unmounting (including clearing the draft
 * or changing conversations) invalidates permission requests and late results. */
export function VoiceInput({ value, onChange, disabled = false, onError, showLabel = false, onBegin, onActiveChange, onPhaseChange, maxLength = 4000 }: {
  maxLength?: number;
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
  const report = (message: string) => onError(message + (
    message.includes(NO_SERVICE_MESSAGE) && (whisper.state === "absent" || whisper.state === "error")
      ? " Или скачайте распознавание на телефон: Настройки → Голосовой ввод → Голос без интернета."
      : ""
  ));
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
    if (transcript) onChange(appendDictation(base.current, transcript, maxLength));
    if (event.isFinal) markFinishing();
  });
  useSpeechRecognitionEvent("end", () => {
    if (!owns.current || viaWhisper.current) return;
    owns.current = starting.current = started.current = finishing.current = false;
    clearTimers(); setPhase("idle");
  });
  useSpeechRecognitionEvent("error", event => {
    // Android Google uses its own Activity, not these iOS SpeechRecognizer callbacks.
    if (!owns.current || viaWhisper.current) return;
    if (event.error !== "aborted") report(voiceErrorMessage(event.error, event.message));
    stop();
  });
  useFocusEffect(useCallback(() => stop, [stop]));
  useEffect(() => {
    const sub = AppState.addEventListener("change", state => { if (state === "background" && !nativeInteractionActive()) stop(); });
    return () => { sub.remove(); stop(); };
  }, [stop]);
  useEffect(() => { if (disabled) stop(); }, [disabled, stop]);
  useEffect(() => stop, [voice.preference, stop]);

  async function startAndroidActivity() {
    // No second capture/recording engine: this is the OS speech UI and its
    // Activity result, returned into the same draft through appendDictation.
    if (Platform.OS !== "android" || disabled || !voice.loaded || voice.saving || owns.current || starting.current) return;
    if (value.length >= maxLength) { onError("Текст слишком длинный для диктовки. Существующий текст сохранён."); return; }
    const token = ++generation.current;
    starting.current = true;
    setPhase("starting");
    try {
      if (!(await hasOnlineSpeechConsent())) {
        onError("Подтвердите использование Google через интернет в разделе Настройки → Голосовой ввод. После этого микрофон будет сразу открывать системное окно.");
        return;
      }
      if (token !== generation.current) return;
      onBegin?.();
      const result = await withNativeInteraction(() => launchAndroidVoiceActivity());
      if (token !== generation.current) return; // canceled, unmounted, locked or switched engine
      if (result.status === "recognized") {
        onChange(appendDictation(value, result.transcript, maxLength));
      } else if (result.status === "empty") {
        onError("Системная служба не вернула текст. Попробуйте ещё раз или используйте микрофон Gboard.");
      }
      // A canceled system dialog is not a speech failure; the draft is intact.
    } catch (e) {
      if (token === generation.current) {
        onError("Системная диктовка недоступна или завершилась с ошибкой. " +
          "Проверьте наличие приложения Google; при необходимости используйте микрофон Gboard. " +
          ((e as Error).message || "").slice(0, 120));
      }
    } finally {
      if (token === generation.current) {
        starting.current = false;
        setPhase("idle");
      }
    }
  }

  async function startWhisper(token: number) {
    const aborter = new AbortController(); controller.current = aborter;
    base.current = value; owns.current = viaWhisper.current = true;
    try {
      const running = await withNativeInteraction(() => startWhisperDictation(
        text => { if (generation.current === token && viaWhisper.current && AppState.currentState === "active" && text) onChange(appendDictation(base.current, text, maxLength)); },
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
  async function start() {
    if (disabled || !voice.loaded || voice.saving || owns.current || starting.current) return;
    if (value.length >= maxLength) { onError("Текст слишком длинный для диктовки. Существующий текст сохранён; добавьте отдельную запись."); return; }
    if (voice.error) { onError(voice.error); return; }
    // On Android the Google option always opens the OS recognition UI directly.
    // Do not first invoke a bound SpeechRecognizer or prompt for an alternate route.
    if (selectedEngine === "system" && Platform.OS === "android")
      return startAndroidActivity();
    if (selectedEngine === "whisper" && whisper.state !== "ready") {
      onError(whisper.state === "unsupported" ? "Whisper недоступен на этом телефоне. Выберите системное распознавание: Настройки → Голосовой ввод." :
        whisper.state === "downloading" ? `Модель Whisper ещё скачивается (${whisper.progress}%). Дождитесь завершения или выберите системное распознавание в настройках.` :
        "Выбран Whisper. Скачайте модель: Настройки → Голосовой ввод → Голос без интернета. Или выберите системное распознавание.");
      return;
    }
    onBegin?.();
    const token = ++generation.current;
    starting.current = true; setPhase("starting");
    if (selectedEngine === "whisper") return startWhisper(token);
    try {
      if (!Speech.isRecognitionAvailable()) throw new Error(NO_SERVICE_MESSAGE);
      // Google uses its online-capable recognizer by default. Do not attempt
      // on-device recognition first: Android may support offline in general
      // but have no Russian offline speech pack (Vivo X200 Pro).
      if (!(await hasOnlineSpeechConsent())) {
        if (generation.current === token) {
          onError("Подтвердите онлайн-распознавание в разделе Настройки → Голосовой ввод.");
          setPhase("idle");
        }
        return;
      }
      if (generation.current !== token) return;
      const currentPermission = await Speech.getPermissionsAsync?.();
      if (generation.current !== token) return;
      const permission = currentPermission?.granted ? currentPermission :
        await withNativeInteraction(() => Speech.requestPermissionsAsync(), { permissionPrompt: true });
      if (generation.current !== token) return;
      if (!permission.granted) throw new Error("Голосовой ввод: нет разрешения на микрофон. Разрешите микрофон для PersAI в настройках телефона.");
      base.current = value;
      owns.current = true; started.current = finishing.current = false;
      Speech.start({
        lang: "ru-RU", interimResults: true, continuous: false, requiresOnDeviceRecognition: false, addsPunctuation: true,
      });
      if (!owns.current) return;
      if (!started.current) watchdog.current = setTimeout(() => {
        if (owns.current && !started.current) { report(startTimeoutMessage()); stop(); }
      }, START_TIMEOUT_MS);
      if (!finishing.current) timer.current = setTimeout(finish, 60_000);
    } catch (e) { if (generation.current === token) { report((e as Error).message || "Голосовой ввод: не удалось начать распознавание."); stop(); } }
    finally { if (generation.current === token) starting.current = false; }
  }
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
      style={{ minWidth: 48, minHeight: 48, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: active ? t.accent : t.soft }}>
      <Feather name={active ? "square" : "mic"} size={21} color={active ? "#fff" : t.accent} />
    </Pressable>}
    {active && showLabel ? <Text accessibilityLiveRegion="polite" style={{ color: t.accent, fontSize: 10, textAlign: "center" }}>{phase === "starting" ? "Готовлю микрофон" : phase === "finishing" ? "Распознаю…" : "Слушаю…"}</Text> : null}
  </View>;
}
