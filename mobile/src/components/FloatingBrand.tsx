import React, { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo, Animated, AppState, Easing, Image, StyleSheet, View,
} from "react-native";
import { useTheme } from "../theme";

/**
 * Decorative hero animation. Only composited transforms run on the native
 * driver, respecting OS reduced-motion preference and background suspension.
 * Accessible copy is supplied by the surrounding screen; no announcement loop.
 */
export function FloatingBrand({ size = 154, motion = true }: {
  size?: number; motion?: boolean;
}) {
  const t = useTheme();
  const value = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(true);
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(v => {
      if (live) setReduceMotion(v);
    }).catch(() => {
      if (live) setReduceMotion(true);
    });
    const accessibility = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    const appState = AppState.addEventListener("change", state => {
      setActive(state === "active");
    });
    return () => { live = false; accessibility.remove(); appState.remove(); };
  }, []);

  useEffect(() => {
    if (!motion || reduceMotion || !active) {
      value.stopAnimation();
      value.setValue(0);
      return;
    }
    const sequence = Animated.loop(Animated.sequence([
      Animated.timing(value, {
        toValue: 1, duration: 3400, easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      }),
      Animated.timing(value, {
        toValue: 0, duration: 3400, easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      }),
    ]));
    sequence.start();
    return () => { sequence.stop(); value.stopAnimation(); };
  }, [active, motion, reduceMotion, value]);

  const translateY = value.interpolate({ inputRange: [0, 1], outputRange: [4, -9] });
  const rotate = value.interpolate({ inputRange: [0, 1], outputRange: ["-1deg", "1.5deg"] });
  const scale = value.interpolate({ inputRange: [0, 1], outputRange: [0.99, 1.025] });
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[styles.shell, { width: size + 52, height: size + 42 }]}>
      <View style={[styles.halo, { width: size * .88, height: size * .88,
        backgroundColor: t.glow, top: 19, left: 35 }]} />
      <View style={[styles.orb, { backgroundColor: t.orbA, top: 5, right: 3 }]} />
      <View style={[styles.orb, { backgroundColor: t.orbB, bottom: 23, left: 0,
        width: 24, height: 24, borderRadius: 12 }]} />
      <Animated.View style={{
        transform: [{ translateY }, { rotate }, { scale }],
      }}>
        <Image source={require("../../assets/icon.png")}
          style={{ width: size, height: size, borderRadius: size * .27 }} resizeMode="cover" />
      </Animated.View>
    </View>
  );
}
const styles = StyleSheet.create({
  shell: { alignItems: "center", justifyContent: "center" },
  halo: { position: "absolute", borderRadius: 999, opacity: .55, transform: [{ scaleX: 1.4 }] },
  orb: { position: "absolute", width: 19, height: 19, borderRadius: 10, opacity: .6 },
});
