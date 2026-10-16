import Feather from "@expo/vector-icons/Feather";
import React, { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../theme";

type Hint = { owner: string; text: string };
let visibleHint: Hint | null = null;
const hintListeners = new Set<() => void>();
const subscribe = (listener: () => void) => { hintListeners.add(listener); return () => { hintListeners.delete(listener); }; };
const currentHint = () => visibleHint;
const showHint = (hint: Hint | null) => { visibleHint = hint; hintListeners.forEach(listener => listener()); };
const dismissHint = (owner: string) => { if (visibleHint?.owner === owner) showHint(null); };
/** A tap explains an action once per app session; holding always explains.
 * Otherwise every «Отправить» covers the chat with the same hint. */
const explainedByTap = new Set<string>();
export const resetActionHints = () => { explainedByTap.clear(); };

/** Visible names make icons discoverable; a tap or hold also explains the
 * action. Hints use no native window, so they cannot steal Android focus. */
export function IconAction({ icon, label, accessibilityLabel, hint, onPress, disabled = false,
  emphasized = false, hintAbove = false, hintAlign = "end" }: {
  icon: React.ComponentProps<typeof Feather>["name"]; label: string; accessibilityLabel: string;
  hint: string; onPress: () => void; disabled?: boolean; emphasized?: boolean; hintAbove?: boolean; hintAlign?: "start" | "end";
}) {
  const t = useTheme(); const owner = useId();
  const visible = useSyncExternalStore(subscribe, currentHint, currentHint);
  const help = visible?.owner === owner ? visible.text : "";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); dismissHint(owner); }, [owner]);
  const explain = () => {
    if (timer.current) clearTimeout(timer.current);
    showHint({ owner, text: hint }); timer.current = setTimeout(() => dismissHint(owner), 2500);
  };
  return <View style={{ position: "relative", zIndex: help ? 10 : 0 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityHint={hint}
      accessibilityState={{ disabled }} disabled={disabled} onLongPress={explain}
      onPress={() => { if (!explainedByTap.has(accessibilityLabel)) { explainedByTap.add(accessibilityLabel); explain(); } onPress(); }}
      style={{ minHeight: 48, minWidth: 56, paddingHorizontal: 7, gap: 3, alignItems: "center", justifyContent: "center", borderRadius: 15,
        backgroundColor: emphasized && !disabled ? t.accent : "transparent", opacity: disabled ? 0.5 : 1 }}>
      <Feather name={icon} size={21} color={emphasized && !disabled ? "#fff" : t.accent} />
      <Text style={{ fontSize: 11, fontWeight: "600", color: emphasized && !disabled ? "#fff" : t.accent }}>{label}</Text>
    </Pressable>
    {help ? <View testID="action-hint" pointerEvents="none" style={{ position: "absolute", ...(hintAlign === "start" ? { left: 0 } : { right: 0 }), ...(hintAbove ? { bottom: "100%", marginBottom: 6 } : { top: "100%", marginTop: 6 }), width: 200,
      padding: 10, backgroundColor: t.soft, borderWidth: 1, borderColor: t.line, borderRadius: 12, elevation: 8 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: t.text, fontSize: 12, lineHeight: 17 }}>{help}</Text>
    </View> : null}
  </View>;
}
