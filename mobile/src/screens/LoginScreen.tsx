import React, { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View, ScrollView, Image } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { authError } from "../ux";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme";

export function LoginScreen() {
  const t = useTheme();
  const { login, register, apiBase, setApiBase } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [needOtp, setNeedOtp] = useState(false);
  const [server, setServer] = useState(apiBase);
  const [showServer, setShowServer] = useState(apiBase.includes("localhost"));
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(mode: "login" | "register") {
    if (busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || !password || (mode === "register" && password.length < 8)) {
      setError("Укажите email и пароль. Для регистрации нужно минимум 8 символов."); return;
    }
    setBusy(true);
    setError("");
    try {
      if (server.trim() !== apiBase) await setApiBase(server);
      if (mode === "register") await register(email.trim(), password);
      else await login(email.trim(), password, needOtp ? otp.trim() : undefined);
    } catch (e) {
      const d = e instanceof ApiError ? e.detail : String((e as Error).message);
      if (d === "otp_required") {
        setNeedOtp(true);
        setError("Введите код из приложения-аутентификатора (или резервный код)");
      } else if (d === "too_many_failed_attempts") setError("Слишком много неудачных попыток — попробуйте позже");
      else if (d === "invalid_otp") setError("Неверный код");
      else if (d === "invalid_credentials") setError("Неверный email или пароль");
      else setError(authError(d));
    } finally {
      setBusy(false);
    }
  }

  const input = [styles.input, { borderColor: t.line, color: t.text, backgroundColor: t.panel }];
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.wrap}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Image source={require("../../assets/icon.png")} style={{ width: 72, height: 72, borderRadius: 20, alignSelf: "center" }} accessibilityLabel="Иконка PIA Agent" />
        <Text style={[styles.title, { color: t.text }]}>PIA Agent</Text>
        <Text style={{ color: t.muted, textAlign: "center", marginBottom: 16 }}>Ваши диалоги, документы и знания — в одном месте. Начните с простого вопроса.</Text>
        <TextInput style={input} placeholder="Email" placeholderTextColor={t.muted} autoCapitalize="none" accessibilityLabel="Email" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <TextInput style={input} placeholder="Пароль (минимум 8 символов)" placeholderTextColor={t.muted} accessibilityLabel="Пароль" autoComplete="password" secureTextEntry={!showPassword} value={password} onChangeText={setPassword} />
        <Pressable accessibilityRole="button" onPress={() => setShowPassword(v => !v)} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: t.accent }}>{showPassword ? "Скрыть пароль" : "Показать пароль"}</Text></Pressable>
        {needOtp ? (
          <TextInput style={input} placeholder="Код 2FA" placeholderTextColor={t.muted} autoCapitalize="none" accessibilityLabel="Код 2FA или резервный код" autoFocus value={otp} onChangeText={setOtp} />
        ) : null}
        {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
        <Pressable disabled={busy} style={[styles.btn, { backgroundColor: t.accent }]} onPress={() => submit("login")}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Войти</Text>}
        </Pressable>
        <Pressable disabled={busy} style={[styles.btn, { borderColor: t.line, borderWidth: 1 }]} onPress={() => submit("register")}>
          <Text style={{ color: t.text, fontWeight: "600" }}>Зарегистрироваться</Text>
        </Pressable>
        <Text style={{ color: t.muted, fontSize: 13 }}>Для первого входа нужен адрес сервера от владельца вашей установки. Пароль хранится на сервере; токены входа — в защищённом хранилище устройства.</Text>
        <Pressable style={{ minHeight: 44, justifyContent: "center" }} onPress={() => setShowServer((v) => !v)}>
          <Text style={{ color: t.muted, textAlign: "center" }}>Сервер: {apiBase}</Text>
        </Pressable>
        {showServer ? (
          <View>
            <Text style={{ color: t.muted }}>Адрес без /app. localhost на телефоне означает сам телефон.</Text>
            <TextInput accessibilityLabel="Адрес сервера" keyboardType="url" style={input} autoCapitalize="none" value={server} onChangeText={setServer} placeholder="https://pia.example.com" placeholderTextColor={t.muted} />
          </View>
        ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  content: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 10 },
  title: { fontSize: 28, fontWeight: "700", textAlign: "center", marginBottom: 12 },
  input: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16 },
  btn: { borderRadius: 10, padding: 13, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 16 },
});
