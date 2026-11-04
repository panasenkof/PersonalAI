import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { DiagnosticLogsScreen } from "../screens/DiagnosticLogsScreen";
import { deleteDiagnosticFiles, getDiagnosticSettings, listDiagnosticFiles } from "../direct-agent/diagnostics";
import { getNebulaVisualMode } from "../design/nebula/visualPreference";

let mockProfile = "guest";
let mockFiles: Array<{ name: string; size: number }> = [];
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
  useFocusEffect: (cb: () => void | (() => void)) => require("react").useEffect(cb, [cb]),
}));
jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const context = React.createContext({ top: 24, bottom: 24, left: 0, right: 0 });
  return {
    useSafeAreaInsets: () => React.useContext(context),
    SafeAreaProvider: ({ children }: any) => React.createElement(context.Provider, { value: { top: 24, bottom: 48, left: 0, right: 0 } }, children),
  };
});
jest.mock("../profile/ProfileContext", () => ({ useProfile: () => mockProfile }));
jest.mock("../direct-agent/diagnostics", () => ({
  DEFAULT_DIAGNOSTICS: { enabled: false, includeContent: false },
  deleteDiagnosticFiles: jest.fn(),
  getDiagnosticSettings: jest.fn(),
  listDiagnosticFiles: jest.fn(),
  setDiagnosticSettings: jest.fn(),
  shareDiagnosticFile: jest.fn(),
}));
jest.mock("../design/nebula/visualPreference", () => ({
  getNebulaVisualMode: jest.fn(), setNebulaVisualMode: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockProfile = "guest";
  mockFiles = [
    { name: "diagnostic-1.jsonl", size: 1024 },
    { name: "diagnostic-2.jsonl", size: 2048 },
  ];
  (getDiagnosticSettings as jest.Mock).mockResolvedValue({ enabled: false, includeContent: false });
  (getNebulaVisualMode as jest.Mock).mockResolvedValue("live");
  (listDiagnosticFiles as jest.Mock).mockImplementation(async () => mockFiles);
  (deleteDiagnosticFiles as jest.Mock).mockImplementation(async () => { mockFiles = []; });
});

test("deletion has a contextual Nebula button, file count, safe cancel and separate irreversible action", async () => {
  const view = render(<DiagnosticLogsScreen />);
  await waitFor(() => view.getByText("Журналы (2)"));
  fireEvent.press(view.getByLabelText("Удалить все журналы"));
  expect(view.getByText("Удалить журналы?")).toBeTruthy();
  expect(view.getByText(/Файлов диагностики для удаления: 2/)).toBeTruthy();
  expect(deleteDiagnosticFiles).not.toHaveBeenCalled();
  fireEvent.press(view.getByLabelText("Оставить журналы"));
  expect(view.queryByText("Удалить журналы?")).toBeNull();
  expect(deleteDiagnosticFiles).not.toHaveBeenCalled();

  fireEvent.press(view.getByLabelText("Удалить все журналы"));
  fireEvent.press(view.getByLabelText("Удалить журналы"));
  await waitFor(() => expect(deleteDiagnosticFiles).toHaveBeenCalledTimes(1));
  expect(deleteDiagnosticFiles).toHaveBeenCalledWith("guest");
  await waitFor(() => view.getByText("Журналы (0)"));
});

test("a new diagnostic file requires a fresh confirmation instead of deleting an outdated scope", async () => {
  const view = render(<DiagnosticLogsScreen />);
  await waitFor(() => view.getByText("Журналы (2)"));
  fireEvent.press(view.getByLabelText("Удалить все журналы"));
  mockFiles = [...mockFiles, { name: "diagnostic-3.jsonl", size: 1024 }];
  fireEvent.press(view.getByLabelText("Удалить журналы"));
  await waitFor(() => view.getByText("Журналы (3)"));
  expect(view.getByText(/Список журналов изменился/)).toBeTruthy();
  expect(deleteDiagnosticFiles).not.toHaveBeenCalled();
});

test("switching profile closes a pending destructive confirmation without deleting files", async () => {
  const view = render(<DiagnosticLogsScreen />);
  await waitFor(() => view.getByText("Журналы (2)"));
  fireEvent.press(view.getByLabelText("Удалить все журналы"));
  mockProfile = "second";
  view.rerender(<DiagnosticLogsScreen />);
  await waitFor(() => expect(view.queryByText("Удалить журналы?")).toBeNull());
  expect(deleteDiagnosticFiles).not.toHaveBeenCalled();
});
