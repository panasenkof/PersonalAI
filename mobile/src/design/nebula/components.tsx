import React from "react";
import Feather from "@expo/vector-icons/Feather";
import { Pressable, Text, View, useColorScheme, type StyleProp, type ViewStyle } from "react-native";
import { nebulaColors, nebulaRadii, nebulaSpacing, nebulaTouch, nebulaTypography, type NebulaColors } from "./tokens";

/**
 * Foundational *functional* UI elements; NOT an orb/background renderer.
 * Existing production screens are deliberately unaffected until migration PRs.
 * The approved REF-ICON-A and REF-ORB-B are mandatory for visual identity.
 */
export function useNebulaColors(): NebulaColors {
  return nebulaColors(useColorScheme() === "dark" ? "dark" : "light");
}

export function NebulaSurface({ children, elevated = false, padding = "md", style, accessibilityLabel }: {
  children: React.ReactNode; elevated?: boolean; padding?: keyof typeof nebulaSpacing;
  style?: StyleProp<ViewStyle>; accessibilityLabel?: string;
}) {
  const c = useNebulaColors();
  return <View accessibilityLabel={accessibilityLabel} style={[{
    backgroundColor: elevated ? c.surfaceElevated : c.surface,
    borderRadius: nebulaRadii.card,
    borderColor: c.border,
    borderWidth: 1,
    padding: nebulaSpacing[padding],
  }, style]}>{children}</View>;
}

export function NebulaHeading({ children, accessibilityRole = "header" }: {
  children: React.ReactNode; accessibilityRole?: "header" | "text";
}) {
  const c = useNebulaColors();
  return <Text accessibilityRole={accessibilityRole} style={{
    color: c.text, fontWeight: "700", ...nebulaTypography.heading,
  }}>{children}</Text>;
}

export function NebulaSection({ title, children }: { title: string; children: React.ReactNode }) {
  const c = useNebulaColors();
  return <View style={{ gap: nebulaSpacing.sm }}>
    <Text accessibilityRole="header" style={{
      fontWeight: "700", color: c.text, ...nebulaTypography.subtitle,
    }}>{title}</Text>
    {children}
  </View>;
}

export function NebulaAction({ icon, label, onPress, disabled = false, variant = "quiet", testID }: {
  icon?: React.ComponentProps<typeof Feather>["name"];
  label: string; onPress: () => void; disabled?: boolean;
  variant?: "quiet" | "primary" | "danger"; testID?: string;
}) {
  const c = useNebulaColors();
  const foreground = variant === "primary" ? c.textOnAccent : variant === "danger" ? c.danger : c.text;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: nebulaSpacing.xs,
      minHeight: nebulaTouch.minimum,
      minWidth: nebulaTouch.minimum,
      paddingHorizontal: nebulaSpacing.md,
      borderRadius: nebulaRadii.field,
      borderWidth: variant === "primary" ? 0 : 1,
      borderColor: c.border,
      backgroundColor: variant === "primary" ? c.accent : c.surfaceElevated,
      opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
    })}>
    {icon ? <Feather name={icon} size={20} color={foreground} /> : null}
    <Text style={{ ...nebulaTypography.label, color: foreground, fontWeight: "600", flexShrink: 1 }}>
      {label}
    </Text>
  </Pressable>;
}

export function NebulaSettingRow({ title, summary, icon, onPress, disabled = false }: {
  title: string; summary?: string;
  icon: React.ComponentProps<typeof Feather>["name"];
  onPress: () => void; disabled?: boolean;
}) {
  const c = useNebulaColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={title}
    accessibilityHint={summary} accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => ({
      flexDirection: "row", alignItems: "center", gap: nebulaSpacing.md,
      minHeight: 72, padding: nebulaSpacing.md,
      borderRadius: nebulaRadii.field,
      borderWidth: 1, borderColor: c.border,
      backgroundColor: pressed ? c.surfaceMuted : c.surface, opacity: disabled ? .5 : 1,
    })}>
    <Feather name={icon} size={22} color={c.accent} />
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <Text style={{ color: c.text, ...nebulaTypography.body, fontWeight: "600" }}>{title}</Text>
      {summary ? <Text style={{ color: c.textSecondary, ...nebulaTypography.label }}>{summary}</Text> : null}
    </View>
    <Feather name="chevron-right" size={19} color={c.textSecondary} />
  </Pressable>;
}
