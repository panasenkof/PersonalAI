import React from "react";
import { render, waitFor } from "@testing-library/react-native";
import { NebulaHomeArtwork } from "../NebulaHomeArtwork.native";
let mockVisible = true, mockFocused = true, mockMounts = 0;
jest.mock("../../../security/visibility", () => ({ useApplicationVisible: () => mockVisible }));
jest.mock("@react-navigation/native", () => ({ useIsFocused: () => mockFocused, useFocusEffect: (fn: any) => require("react").useEffect(fn, [fn]) }));
jest.mock("../visualPreference", () => ({ getNebulaVisualMode: async () => "live" }));
jest.mock("../NebulaSkiaExperiment", () => ({ NebulaSkiaExperiment: (props: any) => {
 const React = require("react"), { View } = require("react-native"); React.useEffect(() => { mockMounts++; }, []);
 return <View testID="native-scene" {...props} />;
} }));
test("background discards GPU surface and restores the same B+C scene", async () => {
 const v = render(<NebulaHomeArtwork size={240} phase="thinking" />);
 await waitFor(() => expect(mockMounts).toBe(1));
 mockVisible = false; v.rerender(<NebulaHomeArtwork size={240} phase="thinking" />); expect(v.queryByTestId("native-scene")).toBeNull();
 mockVisible = true; v.rerender(<NebulaHomeArtwork size={240} phase="thinking" />);
 await waitFor(() => expect(mockMounts).toBe(2));
 expect(v.getByTestId("native-scene").props).toMatchObject({ phase: "thinking", size: 240, clipToCircle: false, homeCanvas: true });
 mockFocused = false; v.rerender(<NebulaHomeArtwork size={240} phase="thinking" />); expect(v.queryByTestId("native-scene")).toBeNull();
});
