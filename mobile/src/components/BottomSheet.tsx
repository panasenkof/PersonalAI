import Feather from "@expo/vector-icons/Feather";
import React, { useLayoutEffect } from "react";
import { Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { registerApplicationModal, useApplicationVisible } from "../security/visibility";

/** Modal panels account for BOTH keyboard resize and system navigation insets.
 * The backdrop and Android Back close the panel, not the underlying screen. */
export function BottomSheet({ visible, title, onClose, children }: {
  visible: boolean; title: string; onClose: () => void; children: React.ReactNode;
}) {
  const appVisible = useApplicationVisible();
  useLayoutEffect(() => {
    if (visible && appVisible) return registerApplicationModal();
  }, [visible, appVisible]);
  const close = () => { Keyboard.dismiss(); onClose(); };
  // Remove the native window immediately; a closing slide/fade can otherwise
  // remain above the app privacy cover in the recent-apps screenshot.
  if (!appVisible) return null;
  return <Modal visible={visible} transparent animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
    <SafeAreaProvider>
      <SheetContent title={title} close={close}>{children}</SheetContent>
    </SafeAreaProvider>
  </Modal>;
}

// A native Modal has its own window. Read its own insets rather than those of
// the Activity underneath (which can exclude Android's navigation bar).
function SheetContent({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const t = useTheme(); const insets = useSafeAreaInsets();
  return <KeyboardAvoidingView style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,.4)", paddingTop: insets.top + 20,
    paddingLeft: insets.left, paddingRight: insets.right }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <Pressable accessibilityRole="button" accessibilityLabel={"Закрыть: " + title} style={{ flex: 1 }} onPress={close} />
      <View accessibilityViewIsModal style={{ maxHeight: "85%", backgroundColor: t.panel, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingTop: 10, paddingBottom: insets.bottom }}>
        <View style={{ width: 40, height: 4, borderRadius: 2, alignSelf: "center", backgroundColor: t.line, marginBottom: 6 }} />
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, gap: 12 }}>
          <Text style={{ flex: 1, color: t.text, fontSize: 22, fontWeight: "800" }}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={"Закрыть панель " + title} style={{ minHeight: 48, minWidth: 44, justifyContent: "center", alignItems: "center" }} onPress={close}>
            <Feather name="x" size={22} color={t.muted} />
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 20, paddingTop: 10, paddingBottom: 28, gap: 12 }}>
          {children}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>;
}
