import { useFocusEffect } from "@react-navigation/native";
import { ExpoSpeechRecognitionModule as Speech, useSpeechRecognitionEvent } from "expo-speech-recognition";
import Feather from "@expo/vector-icons/Feather";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Pressable, Text, View } from "react-native";
import { withNativeInteraction } from "../security/native-interaction";
import { useTheme } from "../theme";
import { IconAction } from "./IconAction";

/** Dictation drafts text only. Offline recognition is preferred; use of the
 * phone's network speech service always requires a separate explicit choice.
 */
export function VoiceInput({ value, onChange, disabled = false, onError, showLabel = false }: {
  value: string; onChange: (text: string) => void; disabled?: boolean; onError: (message: string) => void; showLabel?: boolean;
}) {
  const t = useTheme();
  const [offerNetwork, setOfferNetwork] = useState(false);
  const offline = useRef(true);
  const [listening, setListening] = useState(false);
  const owns = useRef(false);
  const starting = useRef(false);
  const base = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const wasOwner = owns.current;
    owns.current = false; starting.current = false; setListening(false);
    if (wasOwner) Speech.abort();
  }, []);
  useSpeechRecognitionEvent("result", event => {
    if (!owns.current || AppState.currentState !== "active") return;
    const transcript = event.results[0]?.transcript || "";
    if (transcript) onChange((base.current + (base.current ? " " : "") + transcript).slice(0, 4000));
  });
  useSpeechRecognitionEvent("end", () => {
    if (!owns.current) return;
    owns.current = false; starting.current = false; setListening(false);
    if (timer.current) clearTimeout(timer.current);
  });
  useSpeechRecognitionEvent("error", event => {
    if (!owns.current) return;
    if (offline.current && !["aborted", "not-allowed", "no-speech"].includes(event.error)) setOfferNetwork(true);
    if (event.error !== "aborted") onError(event.error === "not-allowed" ? "Разрешите микрофон в настройках телефона." :
      event.error === "no-speech" ? "Речь не услышана. Повторите диктовку." :
        "Распознавание недоступно. Проверьте наличие русского языка в службе распознавания телефона.");
    stop();
  });
  useFocusEffect(useCallback(() => stop, [stop]));
  useEffect(() => {
    const sub = AppState.addEventListener("change", state => { if (state === "background") stop(); });
    return () => { sub.remove(); stop(); };
  }, [stop]);
  useEffect(() => { if (disabled) stop(); }, [disabled, stop]);

  async function start(network = false) {
    if (disabled || owns.current || starting.current) return;
    starting.current = true;
    try {
      if (!Speech.isRecognitionAvailable()) throw new Error("На телефоне нет службы распознавания речи.");
      if (!network && !Speech.supportsOnDeviceRecognition()) {
        starting.current = false;
        Alert.alert("Голосовой ввод", "Автономное распознавание недоступно. Системная служба телефона может отправлять речь своему провайдеру; регистрация в PersAI не нужна.", [
          { text: "Отмена", style: "cancel" }, { text: "Использовать системную службу", onPress: () => void start(true) },
        ]); return;
      }
      const permission = await withNativeInteraction(() => Speech.requestPermissionsAsync());
      if (!permission.granted) throw new Error("Разрешите доступ к микрофону и распознаванию речи.");
      if (!starting.current || AppState.currentState !== "active") return;
      base.current = value.trim(); offline.current = !network; setOfferNetwork(false); owns.current = true; setListening(true);
      Speech.start({ lang: "ru-RU", interimResults: true, continuous: false, requiresOnDeviceRecognition: !network, addsPunctuation: true });
      timer.current = setTimeout(() => { if (owns.current) Speech.stop(); }, 60_000);
    } catch (e) { onError((e as Error).message || "Не удалось начать голосовой ввод."); stop(); }
    finally { starting.current = false; }
  }
  return <View>
    {showLabel ? <IconAction icon={listening ? "square" : "mic"} label={listening ? "Стоп" : "Голос"}
      accessibilityLabel={listening ? "Остановить диктовку" : "Голосовой ввод"} hint={listening ? "Завершить диктовку." : "Надиктовать сообщение. Отправка — отдельной кнопкой."}
      disabled={disabled} emphasized={listening} hintAbove hintAlign="start" onPress={() => listening ? Speech.stop() : void start()} /> : <Pressable accessibilityRole="button" accessibilityLabel={listening ? "Остановить диктовку" : "Голосовой ввод"}
      disabled={disabled} onPress={() => listening ? Speech.stop() : void start()}
      style={{ minWidth: 46, minHeight: 46, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: listening ? t.accent : t.soft }}>
      <Feather name={listening ? "square" : "mic"} size={21} color={listening ? "#fff" : t.accent} />
    </Pressable>}
    {offerNetwork && !listening ? <Pressable accessibilityRole="button" accessibilityLabel="Использовать системную диктовку" disabled={disabled} style={{ minHeight: 44, width: 46, justifyContent: "center" }} onPress={() => Alert.alert("Системная диктовка", "Служба телефона может отправлять речь своему провайдеру. Разрешить её для этой диктовки?", [{ text: "Отмена", style: "cancel" }, { text: "Разрешить", onPress: () => void start(true) }])}><Text style={{ color: t.accent, fontSize: 10, textAlign: "center" }}>Через сервис</Text></Pressable> : null}
    {listening ? <Text style={{ color: t.accent, fontSize: 10, textAlign: "center" }}>Слушаю</Text> : null}
  </View>;
}
