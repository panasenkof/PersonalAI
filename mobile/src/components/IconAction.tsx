import Feather from "@expo/vector-icons/Feather";
import React, { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, ToastAndroid, View } from "react-native";
import { useTheme } from "../theme";

/** Visible names make icons discoverable; a tap or hold also explains the
 * action. Hints use no native window, so they cannot steal Android focus. */
export function IconAction({ icon, label, accessibilityLabel, hint, onPress, disabled = false,
  emphasized = false, hintAbove = false, hintAlign = "end" }: {
  icon: React.ComponentProps<typeof Feather>["name"]; label: string; accessibilityLabel: string;
  hint: string; onPress: () => void; disabled?: boolean; emphasized?: boolean; hintAbove?: boolean; hintAlign?: "start" | "end";
}) {
  const t = useTheme(); const [help, setHelp] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const explain = () => {
    if (Platform.OS === "android") ToastAndroid.show(hint, ToastAndroid.SHORT);
    else {
      if (timer.current) clearTimeout(timer.current);
      setHelp(true); timer.current = setTimeout(() => setHelp(false), 2500);
    }
  };
  return <View style={{ position: "relative", zIndex: help ? 1 : 0 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityHint={hint}
      accessibilityState={{ disabled }} disabled={disabled} onLongPress={explain}
      onPress={() => { explain(); onPress(); }}
      style={{ minHeight: 48, minWidth: 56, paddingHorizontal: 7, gap: 3, alignItems: "center", justifyContent: "center", borderRadius: 15,
        backgroundColor: emphasized && !disabled ? t.accent : "transparent", opacity: disabled ? 0.5 : 1 }}>
      <Feather name={icon} size={21} color={emphasized && !disabled ? "#fff" : t.accent} />
      <Text style={{ fontSize: 11, fontWeight: "600", color: emphasized && !disabled ? "#fff" : t.accent }}>{label}</Text>
    </Pressable>
    {help ? <View pointerEvents="none" style={{ position: "absolute", ...(hintAlign === "start" ? { left: 0 } : { right: 0 }), ...(hintAbove ? { bottom: "100%" } : { top: "100%" }), width: 200,
      padding: 10, backgroundColor: t.soft, borderWidth: 1, borderColor: t.line, borderRadius: 12 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: t.text, fontSize: 12, lineHeight: 17 }}>{hint}</Text>
    </View> : null}
  </View>;
}
