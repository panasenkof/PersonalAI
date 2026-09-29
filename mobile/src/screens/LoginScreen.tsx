import React, { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

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
  const [showServer, setShowServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(mode: "login" | "register") {
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
      else setError(d);
    } finally {
      setBusy(false);
    }
  }

  const input = [styles.input, { borderColor: t.line, color: t.text, backgroundColor: t.panel }];
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.wrap}>
        <Text style={[styles.title, { color: t.text }]}>PIA Agent</Text>
        <TextInput style={input} placeholder="Email" placeholderTextColor={t.muted} autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <TextInput style={input} placeholder="Пароль (минимум 8 символов)" placeholderTextColor={t.muted} secureTextEntry value={password} onChangeText={setPassword} />
        {needOtp ? (
          <TextInput style={input} placeholder="Код 2FA" placeholderTextColor={t.muted} keyboardType="number-pad" autoFocus value={otp} onChangeText={setOtp} />
        ) : null}
        {error ? <Text style={{ color: t.err }}>{error}</Text> : null}
        <Pressable disabled={busy} style={[styles.btn, { backgroundColor: t.accent }]} onPress={() => submit("login")}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Войти</Text>}
        </Pressable>
        <Pressable disabled={busy} style={[styles.btn, { borderColor: t.line, borderWidth: 1 }]} onPress={() => submit("register")}>
          <Text style={{ color: t.text, fontWeight: "600" }}>Зарегистрироваться</Text>
        </Pressable>
        <Pressable onPress={() => setShowServer((v) => !v)}>
          <Text style={{ color: t.muted, textAlign: "center" }}>Сервер: {apiBase}</Text>
        </Pressable>
        {showServer ? (
          <View>
            <TextInput style={input} autoCapitalize="none" value={server} onChangeText={setServer} placeholder="https://pia.example.com" placeholderTextColor={t.muted} />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "center", padding: 20, gap: 10 },
  title: { fontSize: 28, fontWeight: "700", textAlign: "center", marginBottom: 12 },
  input: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16 },
  btn: { borderRadius: 10, padding: 13, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 16 },
});
