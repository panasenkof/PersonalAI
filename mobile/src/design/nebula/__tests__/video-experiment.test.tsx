import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo, AppState, View } from "react-native";
import { NebulaVideoExperiment } from "../NebulaVideoExperiment";

jest.mock("expo-video", () => {
  const React = require("react"); const { View } = require("react-native");
  return { useVideoPlayer: (_src: unknown, setup?: (player: any) => void) => {
    const player = { loop: false, muted: false, play: jest.fn(), pause: jest.fn() };
    setup?.(player); return player;
  }, VideoView: ({ testID }: { testID: string }) => React.createElement(View, { testID }) };
});

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, "addEventListener").mockReturnValue({ remove: jest.fn() } as any);
  jest.replaceProperty(AppState, "currentState", "active");
});
afterEach(() => jest.restoreAllMocks());

test("in full foreground mode the experimental video is rendered", async () => {
  const v = render(<NebulaVideoExperiment phase="thinking" size={170} />);
  await waitFor(() => expect(v.getByTestId("nebula-video-candidate")).toBeTruthy());
  expect(v.getByText("Обрабатываю запрос")).toBeTruthy();
});
test("reduce motion selects a quality static frame and keeps explicit listening status", async () => {
  const v = render(<NebulaVideoExperiment phase="listening" reduceMotion />);
  await waitFor(() => expect(v.getByTestId("nebula-reference-poster")).toBeTruthy());
  expect(v.queryByTestId("nebula-video-candidate")).toBeNull();
  expect(v.getByText("Идёт запись")).toBeTruthy();
});
test("low power does not decode the experimental video while preserving the phase", async () => {
  const v = render(<NebulaVideoExperiment phase="responding" powerConstrained />);
  await waitFor(() => expect(v.getByTestId("nebula-reference-poster")).toBeTruthy());
  expect(v.getByText("Формирую ответ")).toBeTruthy();
});
