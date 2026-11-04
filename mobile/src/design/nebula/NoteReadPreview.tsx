import React, { useState } from "react";
import { Text, View } from "react-native";
import { BottomSheet } from "../../components/BottomSheet";
import { MarkdownText } from "../../components/Markdown";
import { useTheme } from "../../theme";
import { NebulaAction } from "./components";
import { noteReadExcerpt } from "./noteReadExcerpt";
import { nebulaSpacing, nebulaTypography } from "./tokens";

/** Compact reading in the note, entire selectable Markdown in an app-owned
 * sheet with its normal Android Back/close behaviour. No source is changed. */
export function NoteReadPreview({ text, heading, fullTitle, actionLabel, maxLines, testID }: {
  text: string; heading?: string; fullTitle: string; actionLabel: string;
  maxLines: number; testID?: string;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const { preview, needsFullReading } = noteReadExcerpt(text, maxLines);
  return <View testID={testID} style={{ gap: nebulaSpacing.sm }}>
    {heading ? <Text accessibilityRole="header" style={{ color: t.text, ...nebulaTypography.subtitle, fontWeight: "700" }}>{heading}</Text> : null}
    <MarkdownText text={preview} numberOfLines={maxLines} style={{ color: t.text, ...nebulaTypography.body }} />
    {needsFullReading ? <View style={{ alignItems: "flex-start" }}>
      <NebulaAction icon="book-open" label={actionLabel} onPress={() => setOpen(true)} />
    </View> : null}
    {open ? <BottomSheet visible title={fullTitle} onClose={() => setOpen(false)}>
      <Text style={{ color: t.muted, ...nebulaTypography.label }}>Полный текст · можно выделить и скопировать</Text>
      <MarkdownText text={text} style={{ color: t.text, ...nebulaTypography.body }} />
    </BottomSheet> : null}
  </View>;
}
