export * from "react-native-web";
import React from "react";
import { Modal as WebModal } from "react-native-web";
const listeners = new Map<string, Set<(state?: string) => void>>();
export const AppState = {
  currentState: "active",
  addEventListener(event: string, fn: (state?: string) => void) {
    if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn);
    return { remove: () => listeners.get(event)?.delete(fn) };
  },
};
(window as any).__state = (state: string) => { AppState.currentState = state; listeners.get("change")?.forEach(fn => fn(state)); };
// Model the Android Activity focus events emitted by native Dialogs. A plain
// web Modal never emits these, which is why the previous browser QA missed the loop.
export function Modal(props: React.ComponentProps<typeof WebModal>) {
  React.useEffect(() => {
    if (props.visible) {
      const stats = (window as any).__qa;
      stats.modalShows = (stats.modalShows || 0) + 1;
      listeners.get("blur")?.forEach(fn => fn());
      return () => { listeners.get("focus")?.forEach(fn => fn()); };
    }
  }, [props.visible]);
  return React.createElement(WebModal, props);
}
export const Alert = { alert(_title: string, _message: string, buttons: any[] = []) { buttons.at(-1)?.onPress?.(); } };
export const ToastAndroid = { SHORT: 0, show(message: string) { (window as any).__qa.lastHint = message; } };
