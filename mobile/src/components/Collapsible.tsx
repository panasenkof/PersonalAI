import * as SecureStore from "expo-secure-store";
import Feather from "@expo/vector-icons/Feather";
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { nebulaRadii, nebulaSpacing, nebulaTouch, nebulaTypography } from "../design/nebula/tokens";
import { useTheme } from "../theme";

/** Which groups the user opened, remembered across launches (no secrets inside). */
const KEY = "pia.ui.open-groups.v1";
let remembered: Record<string, boolean> | null = null;
let loading: Promise<Record<string, boolean>> | null = null;
const load = (): Promise<Record<string, boolean>> => loading ??= SecureStore.getItemAsync(KEY)
  .then(raw => { const value: Record<string, boolean> = raw ? JSON.parse(raw) : {}; remembered = value; return value; })
  .catch(() => { const value: Record<string, boolean> = {}; remembered = value; return value; });
function remember(id: string, open: boolean) {
  remembered = { ...(remembered || {}), [id]: open };
  void SecureStore.setItemAsync(KEY, JSON.stringify(remembered)).catch(() => undefined);
}

/** A settings group that folds to its title and a one-line summary. */
export function Collapsible({ id, title, summary, defaultOpen = false, forceOpen = false, children, card = true, icon }: {
  id: string; title: string; summary?: string; defaultOpen?: boolean; forceOpen?: boolean; children: React.ReactNode; card?: boolean; icon?: React.ComponentProps<typeof Feather>["name"];
}) {
  const t = useTheme();
  const [open, setOpen] = useState(remembered?.[id] ?? defaultOpen);
  useEffect(() => { let alive = true; void load().then(r => { if (alive && !forceOpen && r[id] !== undefined) setOpen(r[id]); }); return () => { alive = false; }; }, [id, forceOpen]);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const toggle = () => { setOpen(v => { remember(id, !v); return !v; }); };
  const box = card ? { backgroundColor: t.panel, padding: nebulaSpacing.md, gap: nebulaSpacing.sm, borderRadius: nebulaRadii.card, borderWidth: 1, borderColor: t.line } : { gap: 10 };
  return <View style={box}>
    <Pressable accessibilityRole="button" accessibilityLabel={(open ? "Свернуть: " : "Развернуть: ") + title} accessibilityState={{ expanded: open }}
      aria-expanded={open} onPress={toggle} style={{ flexDirection: "row", alignItems: "center", gap: nebulaSpacing.sm, minHeight: nebulaTouch.minimum }}>
      {icon ? <View style={{ padding: nebulaSpacing.xs, borderRadius: nebulaRadii.chip, backgroundColor: t.soft }}><Feather name={icon} size={22} color={t.secondary} /></View> : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ color: t.text, ...nebulaTypography.body, fontWeight: "600" }}>{title}</Text>
        {!open && summary ? <Text style={{ color: t.muted, ...nebulaTypography.label }}>{summary}</Text> : null}
      </View>
      <Feather name={open ? "chevron-up" : "chevron-down"} size={22} color={t.secondary} />
    </Pressable>
    {open ? children : null}
  </View>;
}
