import { useFocusEffect } from "@react-navigation/native";
import { ExpoSpeechRecognitionModule as Speech, useSpeechRecognitionEvent } from "expo-speech-recognition";
import Feather from "@expo/vector-icons/Feather";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Platform, Pressable, Text, View } from "react-native";
import { nativeInteractionActive, withNativeInteraction } from "../security/native-interaction";
import { NO_SERVICE_MESSAGE, START_TIMEOUT_MS, pickRecognitionService, startTimeoutMessage, voiceErrorMessage } from "../media/voice";
import { useTheme } from "../theme";
import { IconAction } from "./IconAction";

/** Consent to the phone's network speech service, asked once per app session. */
let networkConsent = false;

function recognitionService(): string | undefined {
  if (Platform.OS !== "android") return undefined;
  try {
    return pickRecognitionService(Speech.getSpeechRecognitionServices?.() ?? [], Speech.getDefaultRecognitionService?.()?.packageName ?? "");
  } catch { return undefined; }
}

/** Dictation drafts text only. Offline recognition is preferred; use of the
 * phone's network speech service requires an explicit choice. Every failure
 * names its reason: nothing fails silently.
 */
export function VoiceInput({ value, onChange, disabled = false, onError, showLabel = false }: {
  value: string; onChange: (text: string) => void; disabled?: boolean; onError: (message: string) => void; showLabel?: boolean;
}) {
  const t = useTheme();
  const [offerNetwork, setOfferNetwork] = useState(false);
  const offline = useRef(true);
  const service = useRef<string | undefined>(undefined);
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
    if (wasOwner) try { Speech.abort(); } catch { /* already stopped */ }
  }, []);
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
    if (event.error !== "aborted") onError(voiceErrorMessage(event.error, event.message, service.current));
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

  async function start(network = false) {
    if (disabled || owns.current || starting.current) return;
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
        ...(service.current ? { androidRecognitionServicePackage: service.current } : {}),
      });
      watchdog.current = setTimeout(() => {
        if (owns.current && !started.current) { onError(startTimeoutMessage(service.current)); stop(); }
      }, START_TIMEOUT_MS);
      timer.current = setTimeout(() => { if (owns.current) Speech.stop(); }, 60_000);
    } catch (e) { onError((e as Error).message || "Голосовой ввод: не удалось начать распознавание."); stop(); }
    finally { starting.current = false; }
  }
  const offerConsent = () => Alert.alert("Системная диктовка", "Служба телефона может отправлять речь своему серверу. Разрешить её?",
    [{ text: "Отмена", style: "cancel" }, { text: "Разрешить", onPress: () => { networkConsent = true; void start(true); } }]);
  return <View>
    {showLabel ? <IconAction icon={listening ? "square" : "mic"} label={listening ? "Стоп" : "Голос"}
      accessibilityLabel={listening ? "Остановить диктовку" : "Голосовой ввод"} hint={listening ? "Завершить диктовку." : "Надиктовать сообщение. Отправка — отдельной кнопкой."}
      disabled={disabled} emphasized={listening} hintAbove hintAlign="start" onPress={() => listening ? Speech.stop() : void start()} /> : <Pressable accessibilityRole="button" accessibilityLabel={listening ? "Остановить диктовку" : "Голосовой ввод"}
      disabled={disabled} onPress={() => listening ? Speech.stop() : void start()}
      style={{ minWidth: 46, minHeight: 46, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: listening ? t.accent : t.soft }}>
      <Feather name={listening ? "square" : "mic"} size={21} color={listening ? "#fff" : t.accent} />
    </Pressable>}
    {offerNetwork && !listening && !networkConsent ? <Pressable accessibilityRole="button" accessibilityLabel="Использовать системную диктовку" disabled={disabled} style={{ minHeight: 44, width: 46, justifyContent: "center" }} onPress={offerConsent}><Text style={{ color: t.accent, fontSize: 10, textAlign: "center" }}>Через сервис</Text></Pressable> : null}
    {listening ? <Text style={{ color: t.accent, fontSize: 10, textAlign: "center" }}>Слушаю</Text> : null}
  </View>;
}
