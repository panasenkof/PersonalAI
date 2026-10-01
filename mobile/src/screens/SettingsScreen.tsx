import React, { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Switch, Text, TextInput, Pressable, View } from "react-native";

import { authError } from "../ux";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme";
import type { LLMSettings } from "../types";

const CHANNELS = ["telegram", "slack", "whatsapp", "discord"] as const;

export function SettingsScreen() {
  const t = useTheme();
  const { me, refreshMe, logout, apiBase, setApiBase, changePassword } = useAuth();
  const [llm, setLlm] = useState<LLMSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [server, setServer] = useState(apiBase);
  const [msg, setMsg] = useState("");
  const [twofa, setTwofa] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  const [offPassword, setOffPassword] = useState("");
  const [offCode, setOffCode] = useState("");
  const [currentPass, setCurrentPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [passwordOtp, setPasswordOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<Record<string, string>>({});

  useEffect(() => {
    api.llmSettings().then(setLlm).catch((e) => setMsg(String((e as Error).message)));
  }, []);

  const guard = useCallback(async (fn: () => Promise<void>, ok?: string) => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      await fn();
      if (ok) setMsg(ok);
    } catch (e) {
      setMsg(authError(String((e as Error).message)));
    } finally { setBusy(false); }
  }, [busy]);

  const input = [styles.input, { borderColor: t.line, color: t.text, backgroundColor: t.panel }];
  const label = { color: t.muted, fontSize: 12, marginTop: 6 } as const;
  const btn = (bg: string) => [styles.btn, { backgroundColor: bg }];

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      <Text style={[styles.h, { color: t.text }]}>Аккаунт</Text>
      <Text style={{ color: t.text }}>{me?.email} · роль: {me?.role}</Text>

      <Text style={[styles.h, { color: t.text }]}>LLM</Text>
      {llm ? (
        <>
          <View style={styles.row}>
            <Text style={{ color: t.text }}>Локальный провайдер</Text>
            <Switch value={llm.provider_kind === "local"} onValueChange={(v) => setLlm({ ...llm, provider_kind: v ? "local" : "cloud" })} />
          </View>
          <Text style={label}>Base URL (OpenAI-compatible)</Text>
          <TextInput style={input} autoCapitalize="none" value={llm.base_url} onChangeText={(v) => setLlm({ ...llm, base_url: v })} />
          <Text style={label}>API-ключ (пусто = не менять)</Text>
          <TextInput style={input} autoCapitalize="none" secureTextEntry value={apiKey} onChangeText={setApiKey} placeholder="sk-…" placeholderTextColor={t.muted} />
          <Text style={label}>Модель</Text>
          <TextInput style={input} autoCapitalize="none" value={llm.default_model} onChangeText={(v) => setLlm({ ...llm, default_model: v })} />
          <Text style={label}>Модель эмбеддингов</Text>
          <TextInput style={input} autoCapitalize="none" value={llm.embedding_model ?? ""} onChangeText={(v) => setLlm({ ...llm, embedding_model: v || null })} />
          <Pressable
            style={btn(t.accent)}
            onPress={() => guard(async () => {
              setLlm(await api.saveLlmSettings({ ...llm, ...(apiKey ? { api_key: apiKey } : {}) }));
              setApiKey("");
            }, "Сохранено ✔")}
          >
            <Text style={styles.btnText}>Сохранить</Text>
          </Pressable>
        </>
      ) : null}

      <Text style={[styles.h, { color: t.text }]}>Сменить пароль</Text>
      <Text style={{ color: t.muted }}>После смены пароля остальные устройства выйдут из аккаунта. Восстановление забытого пароля пока доступно только через владельца сервера.</Text>
      <TextInput style={input} accessibilityLabel="Текущий пароль" secureTextEntry value={currentPass} onChangeText={setCurrentPass} placeholder="Текущий пароль" placeholderTextColor={t.muted} />
      <TextInput style={input} accessibilityLabel="Новый пароль" secureTextEntry value={newPass} onChangeText={setNewPass} placeholder="Новый пароль (от 8 символов)" placeholderTextColor={t.muted} />
      {me?.totp_enabled ? <TextInput style={input} accessibilityLabel="Код подтверждения смены пароля" autoCapitalize="none" value={passwordOtp} onChangeText={setPasswordOtp} placeholder="Код 2FA или резервный код" placeholderTextColor={t.muted} /> : null}
      <Pressable disabled={busy || !currentPass || newPass.length < 8} style={btn(t.accent)} onPress={() => guard(async () => {
        await changePassword(currentPass, newPass, passwordOtp); setCurrentPass(""); setNewPass(""); setPasswordOtp("");
      }, "Пароль изменён ✔")}><Text style={styles.btnText}>Сменить пароль</Text></Pressable>
      <Text style={[styles.h, { color: t.text }]}>Безопасность</Text>
      <Text style={{ color: me?.totp_enabled ? t.ok : t.muted }}>
        Двухфакторная аутентификация: {me?.totp_enabled ? "включена" : "выключена"}
      </Text>
      {!me?.totp_enabled && !twofa ? (
        <Pressable style={btn(t.accent)} onPress={() => guard(async () => {
          const r = await api.twofaSetup();
          setTwofa({ secret: r.secret, uri: r.otpauth_uri });
        })}>
          <Text style={styles.btnText}>Включить 2FA</Text>
        </Pressable>
      ) : null}
      {twofa ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: t.text }}>Добавьте ключ в приложение-аутентификатор (Google Authenticator, Authy, 1Password):</Text>
          <Text selectable style={[styles.mono, { color: t.text, backgroundColor: t.panel }]}>{twofa.secret}</Text>
          <TextInput style={input} keyboardType="number-pad" placeholder="Код из приложения" placeholderTextColor={t.muted} value={code} onChangeText={setCode} />
          <Pressable style={btn(t.ok)} onPress={() => guard(async () => {
            const r = await api.twofaEnable(code.trim());
            setRecovery(r.recovery_codes);
            setTwofa(null);
            setCode("");
            await refreshMe();
          })}>
            <Text style={styles.btnText}>Подтвердить</Text>
          </Pressable>
        </View>
      ) : null}
      {recovery.length ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: t.text }}>Резервные коды — сохраните, каждый работает один раз:</Text>
          <Text selectable style={[styles.mono, { color: t.text, backgroundColor: t.panel }]}>{recovery.join("\n")}</Text>
        </View>
      ) : null}
      {me?.totp_enabled ? (
        <View style={{ gap: 6 }}>
          <TextInput style={input} secureTextEntry placeholder="Пароль" placeholderTextColor={t.muted} value={offPassword} onChangeText={setOffPassword} />
          <TextInput style={input} keyboardType="number-pad" placeholder="Код 2FA" placeholderTextColor={t.muted} value={offCode} onChangeText={setOffCode} />
          <Pressable style={btn(t.err)} onPress={() => guard(async () => {
            await api.twofaDisable(offPassword, offCode.trim());
            setOffPassword(""); setOffCode(""); setRecovery([]);
            await refreshMe();
          })}>
            <Text style={styles.btnText}>Отключить 2FA</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable
        style={btn(t.muted)}
        onPress={() => Alert.alert("Выйти на всех устройствах?", "Все сессии будут завершены.", [
          { text: "Отмена", style: "cancel" },
          { text: "Выйти", style: "destructive", onPress: () => guard(async () => { await api.logoutAll(); await logout(); }) },
        ])}
      >
        <Text style={styles.btnText}>Выйти на всех устройствах</Text>
      </Pressable>

      <Text style={[styles.h, { color: t.text }]}>Мессенджеры</Text>
      {CHANNELS.map((c) => (
        <View key={c} style={{ gap: 4 }}>
          <View style={styles.row}>
            <Text style={{ color: t.text, textTransform: "capitalize" }}>{c} {me?.channels?.[c] ? "✅ привязан" : ""}</Text>
            <Pressable style={[styles.small, { borderColor: t.line }]} onPress={() => guard(async () => {
              const r = await api.linkCode(c);
              setLinks((l) => ({ ...l, [c]: `${r.code}${r.instructions ? `\n${r.instructions}` : ""}` }));
            })}>
              <Text style={{ color: t.text }}>Код привязки</Text>
            </Pressable>
          </View>
          {links[c] ? <Text selectable style={[styles.mono, { color: t.text, backgroundColor: t.panel }]}>{links[c]}</Text> : null}
        </View>
      ))}

      <Text style={[styles.h, { color: t.text }]}>Сервер</Text>
      <Text style={{ color: t.muted }}>Смена сервера завершает текущую сессию. Нужен адрес HTTPS без /app.</Text>
      <TextInput accessibilityLabel="Адрес сервера" style={input} autoCapitalize="none" value={server} onChangeText={setServer} />
      <Pressable disabled={busy} style={btn(t.muted)} onPress={() => Alert.alert("Сменить сервер?", "Для нового сервера потребуется войти заново.", [{ text: "Отмена", style: "cancel" }, { text: "Сменить", onPress: () => guard(() => setApiBase(server)) }])}>
        <Text style={styles.btnText}>Сохранить адрес</Text>
      </Pressable>

      {msg ? <Text accessibilityRole="alert" style={{ color: msg.includes("✔") || msg.includes("сохранён") ? t.ok : t.err }}>{msg}</Text> : null}
      <Pressable style={btn(t.err)} onPress={() => logout()}>
        <Text style={styles.btnText}>Выйти</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 16, gap: 8, paddingBottom: 48 },
  h: { fontSize: 18, fontWeight: "700", marginTop: 16 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  input: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 15 },
  btn: { borderRadius: 10, padding: 12, alignItems: "center", marginTop: 6 },
  btnText: { color: "#fff", fontWeight: "600" },
  small: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  mono: { fontFamily: "Courier", padding: 8, borderRadius: 8 },
});
