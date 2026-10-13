import { createContext, useContext } from "react";

/** Native Modal creates a separate window above the app cover. Descendants
 * must remove those windows while the application is covered or locked. */
export const ApplicationVisibility = createContext(true);
export const useApplicationVisible = () => useContext(ApplicationVisibility);
