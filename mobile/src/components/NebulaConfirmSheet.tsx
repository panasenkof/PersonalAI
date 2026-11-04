import React from "react";
import { Text, View } from "react-native";
import { BottomSheet } from "./BottomSheet";
import { NebulaAction } from "../design/nebula/components";
import { useTheme } from "../theme";

/** Single app-owned confirmation surface; all actions are visible, labelled
 * Nebula buttons. Native system dialogs (permissions/pickers) are not replaced. */
export function NebulaConfirmSheet({ visible, title, message, confirmLabel, cancelLabel = "Отмена",
  onConfirm, onCancel, danger = false, disabled = false }: {
  visible: boolean; title: string; message: string; confirmLabel: string; cancelLabel?: string;
  onConfirm: () => void; onCancel: () => void; danger?: boolean; disabled?: boolean;
}) {
  const t = useTheme();
  return <BottomSheet visible={visible} title={title} onClose={onCancel}>
    <Text style={{ color: t.text, fontSize: 16, lineHeight: 24 }}>{message}</Text>
    <View style={{ gap: 10, marginTop: 4 }}>
      <NebulaAction icon="x" label={cancelLabel} disabled={disabled} onPress={onCancel} />
      <NebulaAction icon={danger ? "alert-triangle" : "check"} label={confirmLabel}
        variant={danger ? "danger" : "primary"} disabled={disabled} onPress={onConfirm} />
    </View>
  </BottomSheet>;
}
