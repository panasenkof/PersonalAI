import React, { createContext, useContext } from "react";
export const Navigation = createContext<any>(null);
export const useNavigation = () => useContext(Navigation);
export const useRoute = () => ({ params: useContext(Navigation)?.params });
export const useFocusEffect = (cb: () => void | (() => void)) => React.useEffect(cb, [cb]);

export const usePreventRemove = (_prevent: boolean, _cb: any) => {};
