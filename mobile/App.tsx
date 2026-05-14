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

  async function register() {
    const r = await fetch(`${API_BASE}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    setToken(j.access_token);
    setReply("Registered / logged in token received.");
  }

  async function sendMessage() {
    if (!token) return;
    const r = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: message, channel: "mobile" }),
    });
    const j = await r.json();
    setReply(JSON.stringify(j, null, 2));
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>PIA Agent (MVP)</Text>
      <TextInput style={styles.input} placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" />
      <TextInput style={styles.input} placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
      <Button title="Register / get token" onPress={() => register().catch((e) => setReply(String(e)))} />
      <TextInput style={styles.input} placeholder="Message" value={message} onChangeText={setMessage} />
      <Button title="Send to agent" onPress={() => sendMessage().catch((e) => setReply(String(e)))} />
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
