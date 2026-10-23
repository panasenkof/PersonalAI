import React from "react";
import { render } from "@testing-library/react-native";
import { Text } from "react-native";
import { themeFor, useTheme, NebulaAppThemeProvider, NebulaHomeThemeProvider, nebulaHomeColors } from "../../../theme";
import { nebulaPalette, contrastRatio } from "../tokens";
import { memoryNoteType } from "../memoryNotePresentation";

function ColorProbe() { return <Text testID="color">{useTheme().bg}</Text>; }

it("keeps the Home scene isolated while migrating working screens", () => {
  const app = render(<NebulaAppThemeProvider><ColorProbe /></NebulaAppThemeProvider>);
  expect(app.getByTestId("color").props.children).toBe(nebulaPalette.dark.canvas);
  app.unmount();
  const home = render(<NebulaHomeThemeProvider><ColorProbe /></NebulaHomeThemeProvider>);
  expect(home.getByTestId("color").props.children).toBe("#0E1024");
  expect(nebulaHomeColors.panel).toBe("#191C39");
  expect(nebulaHomeColors.orbA).toBe("#267AAE");
  expect(nebulaHomeColors.orbB).toBe("#81539F");
});

it.each(["light", "dark"] as const)("keeps readable content and primary buttons for %s", mode => {
  const t = themeFor(mode);
  expect(contrastRatio(t.text, t.panel)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(t.muted, t.panel)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(t.userText, t.accent)).toBeGreaterThanOrEqual(4.5);
});

it.each([
  [{ source_file: "photo.jpg", source_media: "image" }, "Фото"],
  [{ source_file: "voice.mp3", source_media: "audio" }, "Аудио"],
  [{ source_file: "clip.mp4", source_media: "video" }, "Видео"],
  [{ source_file: "legacy.pdf" }, "Файл"],
  [{ source_url: "https://example.com" }, "Ссылка"],
  [{ source_file: 12, source_url: null }, "Заметка"],
] as const)("labels persisted attachment metadata without opening files: %j", (payload, label) => {
  expect(memoryNoteType({ payload, kind: "note" }).label).toBe(label);
});
