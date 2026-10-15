/** Pure helpers for dictation: which recognition service to use and what a
 * recognition error means, in words the user can act on. */

export const GOOGLE_SPEECH_PACKAGES = ["com.google.android.googlequicksearchbox", "com.google.android.as", "com.google.android.tts"];

/** The phone's default service is used when it has one. A phone without a
 * default (some Xiaomi, Huawei and custom ROMs) gets an installed Google
 * service, otherwise any installed one. */
export function pickRecognitionService(installed: string[], defaultPackage: string): string | undefined {
  if (defaultPackage) return undefined;
  return GOOGLE_SPEECH_PACKAGES.find(p => installed.includes(p)) ?? installed[0];
}

export const serviceName = (pkg?: string) =>
  !pkg ? "служба распознавания телефона" :
  pkg === "com.google.android.googlequicksearchbox" ? "Google (приложение «Google»)" :
  pkg === "com.google.android.as" ? "Google (Android System Intelligence)" :
  pkg === "com.google.android.tts" ? "Google (Синтез и распознавание речи)" : pkg;

/** Plain-language reason for an expo-speech-recognition error event. */
export function voiceErrorMessage(error: string, message = "", service?: string): string {
  const who = serviceName(service);
  const reason =
    error === "not-allowed" ? "нет разрешения на микрофон. Разрешите микрофон для PersAI в настройках телефона." :
    error === "no-speech" || error === "speech-timeout" ? "речь не услышана. Повторите диктовку." :
    error === "audio-capture" ? "микрофон занят другим приложением или недоступен." :
    error === "network" ? "служба распознавания не смогла связаться со своим сервером. Проверьте интернет." :
    error === "language-not-supported" ? "русский язык не установлен в службе распознавания. Добавьте его: Настройки → Система → Язык → Распознавание речи (или в приложении Google → Голос)." :
    error === "service-not-allowed" ? "служба распознавания недоступна или отключена. Проверьте, что приложение Google включено и обновлено." :
    error === "busy" ? "служба распознавания занята. Подождите пару секунд и повторите." :
    error === "client" ? "служба распознавания отклонила запрос. Повторите; если не помогает — обновите приложение Google." :
    "служба распознавания вернула ошибку.";
  const detail = [error, message].filter(Boolean).join(": ").replace(/\s+/g, " ").slice(0, 140);
  return `Голосовой ввод (${who}): ${reason}${detail ? ` Код: «${detail}».` : ""}`;
}

export const NO_SERVICE_MESSAGE = "На телефоне нет службы распознавания речи. Установите или включите приложение Google (оно даёт распознавание речи) и повторите.";
export const START_TIMEOUT_MS = 6000;
export const startTimeoutMessage = (service?: string) =>
  `Голосовой ввод: ${serviceName(service)} не начала запись за ${START_TIMEOUT_MS / 1000} с. Проверьте, что приложение Google включено и обновлено, и повторите.`;
