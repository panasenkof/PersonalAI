import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { SmartSearchCard } from "../SmartSearchCard";
import { VisionModelCard } from "../VisionModelCard";
import { deleteVisionModel, downloadVisionModel, useVisionModelStatus } from "../../media/vision-model-manager";
import { deleteEmbedder, downloadEmbedder, useEmbedderStatus } from "../../media/embedder";
import { stopVectors } from "../../media/vector-runner";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../BottomSheet", () => ({
  BottomSheet: ({ visible, children }: any) => visible ? children : null,
}));
jest.mock("../Collapsible", () => ({
  Collapsible: ({ children }: any) => children,
}));
jest.mock("../VisionIndexControls", () => ({ VisionIndexControls: () => null }));
jest.mock("../../profile/ProfileContext", () => ({ useProfile: () => "guest" }));
jest.mock("../../theme", () => ({
  useTheme: () => ({
    text: "#ffffff", muted: "#abbad8", panel: "#14213d", soft: "#26395c",
    line: "#445574", secondary: "#d1dfff", accent: "#7051db",
    ok: "#66f1af", err: "#ff9faf",
  }),
}));
jest.mock("../../media/vision-model-manager", () => ({
  useVisionModelStatus: jest.fn(), downloadVisionModel: jest.fn(),
  deleteVisionModel: jest.fn(), chooseVisionModel: jest.fn(), cancelVisionModelDownload: jest.fn(),
}));
jest.mock("../../media/embedder", () => ({
  EMBEDDER_APPROX_MB: 90, useEmbedderStatus: jest.fn(), downloadEmbedder: jest.fn(),
  deleteEmbedder: jest.fn(), cancelEmbedderDownload: jest.fn(),
}));
jest.mock("../../media/vector-runner", () => ({
  useVectorState: () => ({ done: 0, total: 0, running: false, error: "" }),
  refreshVectorStatus: jest.fn(() => Promise.resolve()), scheduleVectors: jest.fn(), stopVectors: jest.fn(),
}));
jest.mock("../../direct-agent/enrich-runner", () => ({
  useEnrichState: () => ({ enabled: false, done: 0, pending: 0, running: false, error: "" }),
  loadIndexTermsPreference: jest.fn(() => Promise.resolve()),
  refreshIndexTermsStatus: jest.fn(() => Promise.resolve()),
  scheduleIndexTerms: jest.fn(), setIndexTermsEnabled: jest.fn(),
}));

const modelId = "eg2-vision-440";
const label = "EmbeddingGemma 2 · Фото";
const emptyVision = () => ({
  loaded: true, busy: false, progress: 0, downloadingId: null, activeId: null,
  installed: [], error: "", notice: "",
});
const installedVision = () => ({
  ...emptyVision(), activeId: modelId,
  installed: [{ id: modelId, filename: "verified.litertlm",
    sha256: "a".repeat(64), revision: "b".repeat(40), bytes: 388000000 }],
});

beforeEach(() => {
  jest.clearAllMocks();
  (useVisionModelStatus as jest.Mock).mockReturnValue(emptyVision());
  (useEmbedderStatus as jest.Mock).mockReturnValue({ state: "absent" });
});

test("vision model download names the exact model and needs an explicit Nebula confirmation", () => {
  const ui = render(<VisionModelCard defaultOpen />);
  fireEvent.press(ui.getByLabelText("Скачать " + label));
  expect(downloadVisionModel).not.toHaveBeenCalled();
  expect(ui.getByLabelText("Отмена")).toBeTruthy();
  expect(ui.getByText(/«EmbeddingGemma 2 · Фото»: около 388 МБ/)).toBeTruthy();
  fireEvent.press(ui.getByLabelText("Отмена"));
  expect(downloadVisionModel).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Скачать " + label));
  fireEvent.press(ui.getByLabelText("Скачать модель"));
  expect(downloadVisionModel).toHaveBeenCalledTimes(1);
  expect(downloadVisionModel).toHaveBeenCalledWith(modelId);
});

test("vision model delete is confirmed separately and never deletes another model", () => {
  (useVisionModelStatus as jest.Mock).mockReturnValue(installedVision());
  const ui = render(<VisionModelCard defaultOpen />);
  fireEvent.press(ui.getByLabelText("Удалить " + label));
  expect(deleteVisionModel).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Отмена"));
  expect(deleteVisionModel).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Удалить " + label));
  fireEvent.press(ui.getByLabelText("Удалить модель"));
  expect(deleteVisionModel).toHaveBeenCalledTimes(1);
  expect(deleteVisionModel).toHaveBeenCalledWith(modelId);
});

test("semantic search download and delete never run from opening or cancelling Nebula", () => {
  const ui = render(<SmartSearchCard defaultOpen />);
  fireEvent.press(ui.getByLabelText("Скачать модель поиска по смыслу"));
  expect(downloadEmbedder).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Отмена"));
  expect(downloadEmbedder).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Скачать модель поиска по смыслу"));
  fireEvent.press(ui.getByLabelText("Скачать модель"));
  expect(downloadEmbedder).toHaveBeenCalledTimes(1);
  ui.unmount();
  (useEmbedderStatus as jest.Mock).mockReturnValue({ state: "ready" });
  const ready = render(<SmartSearchCard defaultOpen />);
  fireEvent.press(ready.getByLabelText("Удалить модель поиска по смыслу"));
  expect(deleteEmbedder).not.toHaveBeenCalled();
  expect(stopVectors).not.toHaveBeenCalled();
  fireEvent.press(ready.getByLabelText("Отмена"));
  expect(deleteEmbedder).not.toHaveBeenCalled();
  fireEvent.press(ready.getByLabelText("Удалить модель поиска по смыслу"));
  fireEvent.press(ready.getByLabelText("Удалить модель"));
  expect(deleteEmbedder).toHaveBeenCalledTimes(1);
  expect(stopVectors).toHaveBeenCalledTimes(1);
});
