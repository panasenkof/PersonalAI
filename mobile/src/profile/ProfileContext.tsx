import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { savedMemoryProfile } from "../security/active-profile";
import { useTheme } from "../theme";

const ProfileContext = createContext<string | null>(null);

/** One device profile owns the encrypted memory, chats and model connections. */
export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const [profile, setProfile] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    savedMemoryProfile().then(setProfile).catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  if (!profile) {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 24, backgroundColor: t.bg }}>
      {failed ? <>
        <Text accessibilityRole="alert" style={{ color: t.err, textAlign: "center" }}>Не удалось открыть защищённое хранилище телефона.</Text>
        <Pressable accessibilityRole="button" onPress={load} style={{ minHeight: 44, justifyContent: "center" }}>
          <Text style={{ color: t.accent, fontWeight: "700" }}>Повторить</Text>
        </Pressable>
      </> : <ActivityIndicator accessibilityLabel="Загрузка профиля" />}
    </View>;
  }
  return <ProfileContext.Provider value={profile}>{children}</ProfileContext.Provider>;
}

export function useProfile(): string {
  const profile = useContext(ProfileContext);
  if (!profile) throw new Error("ProfileProvider missing");
  return profile;
}
