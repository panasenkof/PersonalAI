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
import { useTheme } from "../theme";
import { IconAction } from "./IconAction";

/** Consent to the phone's network speech service, asked once per app session. */
let networkConsent = false;

function recognitionService(): ServiceChoice | undefined {
  if (Platform.OS !== "android") return undefined;
  try {
    return pickRecognitionService(Speech.getSpeechRecognitionServices?.() ?? [], Speech.getDefaultRecognitionService?.()?.packageName ?? "");
  } catch { return undefined; }
}

/** Dictation drafts text only. Order: Whisper on the phone (once downloaded),
 * then the phone's own offline recognition, then the phone's network speech
 * service only by explicit choice. Every failure names its reason. */
export function VoiceInput({ value, onChange, disabled = false, onError, showLabel = false }: {
  value: string; onChange: (text: string) => void; disabled?: boolean; onError: (message: string) => void; showLabel?: boolean;
}) {
  const t = useTheme();
  const whisper = useWhisperStatus();
  const session = useRef<DictationSession | null>(null);
  const viaWhisper = useRef(false);
  /** Without Google and without the model, point to the on-device model. */
  const report = (message: string) => onError(message + (whisper.state === "absent" || whisper.state === "error" ?
    " Или включите распознавание на самом телефоне: Настройки → Голос без интернета." : ""));
  const [offerNetwork, setOfferNetwork] = useState(false);
  const offline = useRef(true);
  const service = useRef<ServiceChoice | undefined>(undefined);
  const [listening, setListening] = useState(false);
  const owns = useRef(false);
  const started = useRef(false);
  const starting = useRef(false);
  const base = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = () => {
    if (timer.current) clearTimeout(timer.current);
    if (watchdog.current) clearTimeout(watchdog.current);
    timer.current = watchdog.current = null;
  };
  const stop = useCallback(() => {
    clearTimers();
    const wasOwner = owns.current;
    owns.current = false; starting.current = false; started.current = false; setListening(false);
    if (viaWhisper.current) { viaWhisper.current = false; void session.current?.stop(); session.current = null; }
    else if (wasOwner) try { Speech.abort(); } catch { /* already stopped */ }
  }, []);
  /** «Стоп»: the recognizer finishes the last phrase before ending. */
  const finish = () => { if (viaWhisper.current) void session.current?.stop(); else Speech.stop(); };
  useSpeechRecognitionEvent("start", () => {
    started.current = true;
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = null;
  });
  useSpeechRecognitionEvent("result", event => {
    if (!owns.current || AppState.currentState !== "active") return;
    const transcript = event.results[0]?.transcript || "";
    if (transcript) onChange((base.current + (base.current ? " " : "") + transcript).slice(0, 4000));
  });
  useSpeechRecognitionEvent("end", () => {
    if (!owns.current) return;
    owns.current = false; starting.current = false; started.current = false; setListening(false);
    clearTimers();
  });
  useSpeechRecognitionEvent("error", event => {
    if (!owns.current) return;
    if (offline.current && !["aborted", "not-allowed", "no-speech", "speech-timeout"].includes(event.error)) setOfferNetwork(true);
    if (event.error !== "aborted") report(voiceErrorMessage(event.error, event.message, service.current));
    stop();
  });
  useFocusEffect(useCallback(() => stop, [stop]));
  useEffect(() => {
    // The microphone permission dialog briefly backgrounds the app on Android;
    // that must not cancel the dictation it was asked for.
    const sub = AppState.addEventListener("change", state => { if (state === "background" && !nativeInteractionActive()) stop(); });
    return () => { sub.remove(); stop(); };
  }, [stop]);
  useEffect(() => { if (disabled) stop(); }, [disabled, stop]);

  async function startWhisper() {
    starting.current = true;
    base.current = value.trim(); owns.current = true; viaWhisper.current = true; setListening(true);
    try {
      const running = await withNativeInteraction(() => startWhisperDictation(
        text => { if (viaWhisper.current && text) onChange((base.current + (base.current ? " " : "") + text).slice(0, 4000)); },
        message => onError(message),
        () => { if (!viaWhisper.current) return; viaWhisper.current = false; owns.current = false; session.current = null; setListening(false); clearTimers(); }));
      if (!viaWhisper.current) { void running.stop(); return; }
      session.current = running;
      timer.current = setTimeout(() => { if (viaWhisper.current) void session.current?.stop(); }, 60_000);
    } catch (e) { onError((e as Error).message || "Голос на телефоне: не удалось начать диктовку."); stop(); }
    finally { starting.current = false; }
  }
  async function start(network = false) {
    if (disabled || owns.current || starting.current) return;
    if (whisper.state === "ready" && !network) return startWhisper();
    if (whisper.state === "downloading" && !network) { onError(`Модель распознавания ещё скачивается (${whisper.progress}%). Подождите или используйте системную службу.`); }
    starting.current = true;
    try {
      if (!Speech.isRecognitionAvailable()) throw new Error(NO_SERVICE_MESSAGE);
      const useNetwork = network || networkConsent || !Speech.supportsOnDeviceRecognition();
      if (useNetwork && !network && !networkConsent) {
        starting.current = false;
        Alert.alert("Голосовой ввод", "Распознавание без интернета на этом телефоне недоступно. Системная служба телефона (обычно Google) может отправлять речь своему серверу; регистрация в PersAI не нужна.", [
          { text: "Отмена", style: "cancel" },
          { text: "Использовать системную службу", onPress: () => { networkConsent = true; void start(true); } },
        ]); return;
      }
      const permission = await withNativeInteraction(() => Speech.requestPermissionsAsync());
      if (!permission.granted) throw new Error("Голосовой ввод: нет разрешения на микрофон. Разрешите микрофон для PersAI в настройках телефона.");
      if (disabled) return;
      service.current = recognitionService();
      base.current = value.trim(); offline.current = !useNetwork; setOfferNetwork(false);
      owns.current = true; started.current = false; setListening(true);
      Speech.start({
        lang: "ru-RU", interimResults: true, continuous: false, requiresOnDeviceRecognition: !useNetwork, addsPunctuation: true,
        ...(service.current?.pkg ? { androidRecognitionServicePackage: service.current.pkg } : {}),
      });
      watchdog.current = setTimeout(() => {
        if (owns.current && !started.current) { report(startTimeoutMessage(service.current)); stop(); }
      }, START_TIMEOUT_MS);
      timer.current = setTimeout(() => { if (owns.current) Speech.stop(); }, 60_000);
    } catch (e) { report((e as Error).message || "Голосовой ввод: не удалось начать распознавание."); stop(); }
    finally { starting.current = false; }
  }
  const offerConsent = () => Alert.alert("Системная диктовка", "Служба телефона может отправлять речь своему серверу. Разрешить её?",
    [{ text: "Отмена", style: "cancel" }, { text: "Разрешить", onPress: () => { networkConsent = true; void start(true); } }]);
  return <View>
    {showLabel ? <IconAction icon={listening ? "square" : "mic"} label={listening ? "Стоп" : "Голос"}
      accessibilityLabel={listening ? "Остановить диктовку" : "Голосовой ввод"} hint={listening ? "Завершить диктовку." : "Надиктовать сообщение. Отправка — отдельной кнопкой."}
      disabled={disabled} emphasized={listening} hintAbove hintAlign="start" onPress={() => listening ? finish() : void start()} /> : <Pressable accessibilityRole="button" accessibilityLabel={listening ? "Остановить диктовку" : "Голосовой ввод"}
      disabled={disabled} onPress={() => listening ? finish() : void start()}
      style={{ minWidth: 46, minHeight: 46, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: listening ? t.accent : t.soft }}>
      <Feather name={listening ? "square" : "mic"} size={21} color={listening ? "#fff" : t.accent} />
    </Pressable>}
    {offerNetwork && !listening && !networkConsent ? <Pressable accessibilityRole="button" accessibilityLabel="Использовать системную диктовку" disabled={disabled} style={{ minHeight: 44, width: 46, justifyContent: "center" }} onPress={offerConsent}><Text style={{ color: t.accent, fontSize: 10, textAlign: "center" }}>Через сервис</Text></Pressable> : null}
    {listening ? <Text style={{ color: t.accent, fontSize: 10, textAlign: "center" }}>Слушаю</Text> : null}
  </View>;
}
