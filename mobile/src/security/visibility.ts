import { createContext, useContext } from "react";

/** Native Modal creates a separate window above the app cover. Descendants
 * must remove those windows while the application is covered or locked. */
export const ApplicationVisibility = createContext(true);
export const useApplicationVisible = () => useContext(ApplicationVisibility);

// Android Dialogs take focus from their hosting Activity and emit AppState
// blur, even while the app stays active. Register before showing a native
// window so that this event cannot cover/unmount the very Dialog that caused it.
const applicationModals = new Set<symbol>();
export const applicationModalActive = () => applicationModals.size > 0;
export function registerApplicationModal(): () => void {
  const token = Symbol("application-modal");
  applicationModals.add(token);
  return () => { applicationModals.delete(token); };
}
