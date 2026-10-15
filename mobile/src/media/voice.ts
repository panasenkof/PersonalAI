/** Pure helpers for dictation: which recognition service to use and what a
 * recognition error means, in words the user can act on. */

export const GOOGLE_SPEECH_PACKAGES = ["com.google.android.googlequicksearchbox", "com.google.android.as", "com.google.android.tts"];

export type ServiceChoice = { pkg?: string; installed: string[]; defaultPackage: string };
/** The phone's default service is used when it has one. A phone without a
 * default (some Xiaomi, Huawei and custom ROMs) gets an installed Google
 * service. Other apps' services (e.g. com.anthropic.claude) serve only their
 * own app and are never picked. */
export function pickRecognitionService(installed: string[], defaultPackage: string): ServiceChoice {
  const pkg = defaultPackage ? undefined : GOOGLE_SPEECH_PACKAGES.find(p => installed.includes(p));
  return { pkg, installed, defaultPackage };
}
/** What the phone offers, for error messages the user can act on. */
export function serviceDiagnosis(choice?: ServiceChoice): string {
  if (!choice) return "";
  if (choice.defaultPackage || choice.pkg) return "";
  return ` На телефоне не выбрана служба распознавания по умолчанию и нет службы Google${choice.installed.length ? ` (найдены только: ${choice.installed.join(", ")} — они работают лишь в своих приложениях)` : ""}. ` +
    "Установите приложение Google (или «Распознавание речи от Google») и выберите его: Настройки → Приложения → Приложения по умолчанию → Голосовой ввод.";
}

export const serviceName = (pkg?: string) =>
  !pkg ? "служба распознавания телефона" :
  pkg === "com.google.android.googlequicksearchbox" ? "Google (приложение «Google»)" :
  pkg === "com.google.android.as" ? "Google (Android System Intelligence)" :
  pkg === "com.google.android.tts" ? "Google (Синтез и распознавание речи)" : pkg;

/** Plain-language reason for an expo-speech-recognition error event. */
export function voiceErrorMessage(error: string, message = "", choice?: ServiceChoice): string {
  const who = serviceName(choice?.pkg || choice?.defaultPackage || undefined);
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
  return `Голосовой ввод (${who}): ${reason}${detail ? ` Код: «${detail}».` : ""}${serviceDiagnosis(choice)}`;
}

export const NO_SERVICE_MESSAGE = "На телефоне нет службы распознавания речи. Установите или включите приложение Google (оно даёт распознавание речи) и повторите.";
export const START_TIMEOUT_MS = 6000;
export const startTimeoutMessage = (choice?: ServiceChoice) => {
  const diagnosis = serviceDiagnosis(choice);
  return `Голосовой ввод: ${serviceName(choice?.pkg || choice?.defaultPackage || undefined)} не начала запись за ${START_TIMEOUT_MS / 1000} с.` +
    (diagnosis || " Проверьте, что приложение Google включено и обновлено, и повторите.");
};
