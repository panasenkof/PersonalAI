import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { SafeAreaFrameContext, SafeAreaInsetsContext } from "../node_modules/react-native-safe-area-context/src/index";
export * from "../node_modules/react-native-safe-area-context/src/index";

// Browsers supply zero CSS env insets. Supply deterministic OS metrics to the
// real navigators instead of replacing the tab bar with a padded fixture.
const osInsets = () => ({ top: 24, bottom: (window as any).__safeBottom ?? 24, left: 0, right: 0 });
(window as any).__insets = (bottom: number) => {
  (window as any).__safeBottom = bottom;
  window.dispatchEvent(new Event("qa-insets"));
};
export const SafeAreaProvider = React.forwardRef<any, any>(({ children, initialMetrics, initialSafeAreaInsets, ...props }, ref) => {
  const [insets, setInsets] = useState(osInsets);
  const [frame, setFrame] = useState({ x: 0, y: 0, width: innerWidth, height: innerHeight });
  useEffect(() => {
    const resize = () => setFrame({ x: 0, y: 0, width: innerWidth, height: innerHeight });
    const update = () => setInsets(osInsets());
    window.addEventListener("resize", resize); window.addEventListener("qa-insets", update);
    return () => { window.removeEventListener("resize", resize); window.removeEventListener("qa-insets", update); };
  }, []);
  return <View {...props} ref={ref} style={[{ flex: 1 }, props.style]}>
    <SafeAreaFrameContext.Provider value={frame}><SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider></SafeAreaFrameContext.Provider>
  </View>;
});
