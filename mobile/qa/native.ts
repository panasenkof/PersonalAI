export * from "react-native-web";
const listeners = new Map<string, Set<(state?: string) => void>>();
export const AppState = {
  currentState: "active",
  addEventListener(event: string, fn: (state?: string) => void) {
    if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn);
    return { remove: () => listeners.get(event)?.delete(fn) };
  },
};
(window as any).__state = (state: string) => { AppState.currentState = state; listeners.get("change")?.forEach(fn => fn(state)); };
export const Alert = { alert(_title: string, _message: string, buttons: any[] = []) { buttons.at(-1)?.onPress?.(); } };
