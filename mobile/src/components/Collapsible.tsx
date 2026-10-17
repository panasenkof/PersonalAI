import * as SecureStore from "expo-secure-store";
import Feather from "@expo/vector-icons/Feather";
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../theme";

/** Which groups the user opened, remembered across launches (no secrets inside). */
const KEY = "pia.ui.open-groups.v1";
let remembered: Record<string, boolean> | null = null;
let loading: Promise<Record<string, boolean>> | null = null;
const load = () => loading ??= SecureStore.getItemAsync(KEY)
  .then(raw => (remembered = raw ? JSON.parse(raw) : {}) as Record<string, boolean>)
  .catch(() => (remembered = {}));
function remember(id: string, open: boolean) {
  remembered = { ...(remembered || {}), [id]: open };
  void SecureStore.setItemAsync(KEY, JSON.stringify(remembered)).catch(() => undefined);
}

/** A settings group that folds to its title and a one-line summary. */
export function Collapsible({ id, title, summary, defaultOpen = false, children, card = true }: {
  id: string; title: string; summary?: string; defaultOpen?: boolean; children: React.ReactNode; card?: boolean;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(remembered?.[id] ?? defaultOpen);
  useEffect(() => { let alive = true; void load().then(r => { if (alive && r[id] !== undefined) setOpen(r[id]); }); return () => { alive = false; }; }, [id]);
  const toggle = () => { setOpen(v => { remember(id, !v); return !v; }); };
  const box = card ? { backgroundColor: t.panel, padding: 20, gap: 10, borderRadius: 22, borderWidth: 1, borderColor: t.line } : { gap: 10 };
  return <View style={box} accessibilityLabel={title}>
    <Pressable accessibilityRole="button" accessibilityLabel={(open ? "Свернуть: " : "Развернуть: ") + title} accessibilityState={{ expanded: open }}
      aria-expanded={open} onPress={toggle} style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: t.text, fontSize: card ? 19 : 17, fontWeight: "700" }}>{title}</Text>
        {!open && summary ? <Text numberOfLines={2} style={{ color: t.muted, fontSize: 13 }}>{summary}</Text> : null}
      </View>
      <Feather name={open ? "chevron-up" : "chevron-down"} size={22} color={t.accent} />
    </Pressable>
    {open ? children : null}
  </View>;
}
