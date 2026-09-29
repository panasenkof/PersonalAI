import React, { useState } from "react";
import { Button, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE || "http://localhost:8000";

export default function App() {
  const [email, setEmail] = useState("demo@example.com");
  const [password, setPassword] = useState("secret1234");
  const [token, setToken] = useState<string | null>(null);
  const [message, setMessage] = useState("Добавь машину Toyota Camry 2020");
  const [reply, setReply] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);

  async function register() {
    const r = await fetch(`${API_BASE}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    setToken(j.access_token);
    setReply("Вход выполнен.");
  }

  async function sendMessage() {
    if (!token) return;
    const body: Record<string, unknown> = { text: message, channel: "mobile" };
    if (conversationId) body.conversation_id = conversationId;
    const r = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) {
      setReply(JSON.stringify(j, null, 2));
      return;
    }
    if (j.conversation_id) setConversationId(j.conversation_id);
    if (j.assistant_text) {
      setReply(j.assistant_text);
      return;
    }
    // queue mode: poll the job until it finishes
    setReply("…думаю (задача в очереди)");
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const rj = await fetch(`${API_BASE}/v1/jobs/${j.job_id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const job = await rj.json();
      if (job.status === "completed") {
        setReply(job.result?.assistant_text ?? JSON.stringify(job, null, 2));
        return;
      }
      if (job.status === "failed") {
        setReply(`Ошибка: ${job.error}`);
        return;
      }
    }
    setReply("Таймаут: задача не завершилась за 60 с");
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>PIA Agent</Text>
      <TextInput style={styles.input} placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" />
      <TextInput style={styles.input} placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
      <Button title="Войти / зарегистрироваться" onPress={() => register().catch((e) => setReply(String(e)))} />
      <TextInput style={styles.input} placeholder="Message" value={message} onChangeText={setMessage} />
      <Button title="Отправить агенту" onPress={() => sendMessage().catch((e) => setReply(String(e)))} />
      <View style={{ marginTop: 12 }}>
        <Text selectable>{reply}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 8 },
  title: { fontSize: 20, fontWeight: "600", marginBottom: 8 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 },
});
