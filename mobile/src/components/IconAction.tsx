import Feather from "@expo/vector-icons/Feather";
import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
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
  emphasized = false, compact = false, hintAbove = false, hintAlign = "end" }: {
  icon: React.ComponentProps<typeof Feather>["name"]; label: string; accessibilityLabel: string;
  hint: string; onPress: () => void; disabled?: boolean; emphasized?: boolean; compact?: boolean; hintAbove?: boolean; hintAlign?: "start" | "center" | "end";
}) {
  const t = useTheme(); const owner = useId();
  const { width: viewportWidth } = useWindowDimensions();
  const anchor = useRef<View>(null);
  const [hintLeft, setHintLeft] = useState(0);
  const hintWidth = Math.min(200, Math.max(0, viewportWidth - 16));
  const visible = useSyncExternalStore(subscribe, currentHint, currentHint);
  const help = visible?.owner === owner ? visible.text : "";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); dismissHint(owner); }, [owner]);
  const explain = () => {
    if (timer.current) clearTimeout(timer.current);
    showHint({ owner, text: hint });
    timer.current = setTimeout(() => dismissHint(owner), 2500);
    anchor.current?.measureInWindow((x, _y, width) => {
      const preferred = hintAlign === "start" ? x : hintAlign === "center" ? x + (width - hintWidth) / 2 : x + width - hintWidth;
      setHintLeft(Math.max(8, Math.min(preferred, viewportWidth - hintWidth - 8)) - x);

    });
  };
  return <View ref={anchor} collapsable={false} style={{ position: "relative", zIndex: help ? 10 : 0 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityHint={hint}
      accessibilityState={{ disabled }} disabled={disabled} onLongPress={explain}
      onPress={() => { if (!explainedByTap.has(accessibilityLabel)) { explainedByTap.add(accessibilityLabel); explain(); } onPress(); }}
      style={{ minHeight: 48, minWidth: compact ? 48 : 56, paddingHorizontal: compact ? 0 : 7, gap: 3, alignItems: "center", justifyContent: "center", borderRadius: 15,
        backgroundColor: emphasized && !disabled ? t.accent : "transparent", opacity: disabled ? 0.5 : 1 }}>
      <Feather name={icon} size={21} color={emphasized && !disabled ? "#fff" : t.accent} />
      {!compact ? <Text style={{ fontSize: 11, fontWeight: "600", color: emphasized && !disabled ? "#fff" : t.accent }}>{label}</Text> : null}
    </Pressable>
    {help ? <View testID="action-hint" pointerEvents="none" style={{ position: "absolute", left: hintLeft, ...(hintAbove ? { bottom: "100%", marginBottom: 6 } : { top: "100%", marginTop: 6 }), width: hintWidth,
      padding: 10, backgroundColor: t.soft, borderWidth: 1, borderColor: t.line, borderRadius: 12, elevation: 8 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: t.text, fontSize: 12, lineHeight: 17 }}>{help}</Text>
    </View> : null}
  </View>;
}
