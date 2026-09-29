import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { api } from "../api/client";
import { useTheme } from "../theme";
import type { Fact } from "../types";

/** Data read from a photo/PDF waits here until the user confirms it (nothing is saved before that). */
export function FactCard({ fact, onResolved }: { fact: Fact; onResolved?: (id: string) => void }) {
  const t = useTheme();
  const [state, setState] = useState<"idle" | "busy" | "confirmed" | "rejected">("idle");
  const [error, setError] = useState("");

  async function act(action: "confirm" | "reject") {
    setState("busy");
    setError("");
    try {
      await api.resolveFact(fact.id, action);
      setState(action === "confirm" ? "confirmed" : "rejected");
      onResolved?.(fact.id);
    } catch (e) {
      setState("idle");
      setError(String((e as Error).message));
    }
  }

  return (
    <View style={[styles.card, { backgroundColor: t.warn, borderColor: t.line }]}>
      <Text style={{ color: t.text, fontWeight: "600" }}>📝 Проверьте распознанные данные</Text>
      <Text style={{ color: t.text }}>{fact.summary ?? fact.kind}</Text>
      {state === "idle" || state === "busy" ? (
        <View style={styles.row}>
          <Pressable disabled={state === "busy"} style={[styles.btn, { backgroundColor: t.ok }]} onPress={() => act("confirm")}>
            {state === "busy" ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Подтвердить</Text>}
          </Pressable>
          <Pressable disabled={state === "busy"} style={[styles.btn, { backgroundColor: t.err }]} onPress={() => act("reject")}>
            <Text style={styles.btnText}>Отклонить</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={{ color: t.muted }}>{state === "confirmed" ? "✅ Сохранено в базе знаний" : "❌ Отклонено"}</Text>
      )}
      {error ? <Text style={{ color: t.err }}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8, marginVertical: 4, alignSelf: "stretch" },
  row: { flexDirection: "row", gap: 8 },
  btn: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, minWidth: 110, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "600" },
});
