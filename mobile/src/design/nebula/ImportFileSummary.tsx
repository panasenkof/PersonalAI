import React, { useState } from "react";
import Feather from "@expo/vector-icons/Feather";
import { Text, View } from "react-native";
import { useTheme } from "../../theme";
import { nebulaRadii, nebulaSpacing, nebulaTypography } from "./tokens";
import { NebulaAction } from "./components";

export type ImportSummaryFile = { id: string; name: string; kind: string };

/** Only a presentation of already chosen files. The import screen owns all originals,
 * recognition, privacy consent and writes; no file state is copied here. */
export function ImportFileSummary({ files, preview }: {
  files: ImportSummaryFile[]; preview?: React.ReactNode;
}) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  const visible = files.length > 2 && !expanded ? files.slice(0, 2) : files;
  return <View testID="import-file-summary" style={{
    backgroundColor: t.panel, padding: nebulaSpacing.md, borderRadius: nebulaRadii.card,
    borderWidth: 1, borderColor: t.line, gap: nebulaSpacing.sm,
  }}>
    <Text style={{ color: t.text, fontWeight: "700", ...nebulaTypography.body }}>
      {files.length > 1 ? "Вложения · " + files.length : files[0]?.name || "Вложение"}
    </Text>
    {files.length > 1 ? <View style={{ gap: nebulaSpacing.xs }}>
      {visible.map((file, i) => <View key={file.id} testID="import-selected-file"
        style={{ minHeight: 36, flexDirection: "row", alignItems: "center", gap: nebulaSpacing.sm }}>
        <Feather name="file" color={t.secondary} size={18} />
        <View style={{ minWidth: 0, flex: 1 }}>
          <Text numberOfLines={1} style={{ color: t.text, ...nebulaTypography.label }}>{i + 1}. {file.name}</Text>
          <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12 }}>{file.kind}</Text>
        </View>
      </View>)}
      {files.length > 2 ? <NebulaAction icon={expanded ? "chevron-up" : "list"}
        label={expanded ? "Свернуть вложения" : "Все вложения (" + files.length + ")"}
        accessibilityLabel={expanded ? "Свернуть список вложений" : "Показать все вложения"}
        onPress={() => setExpanded(v => !v)} /> : null}
    </View> : null}
    {preview}
  </View>;
}
