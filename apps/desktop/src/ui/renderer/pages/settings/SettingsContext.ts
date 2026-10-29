/**
 * SettingsContext - provides all settings state and callbacks to tab components
 * via React context, avoiding massive prop drilling.
 *
 * The main SettingsPage component creates this context and fills it with
 * the full internal state object.  Each extracted tab component reads
 * only what it needs via `useSettingsContext()`.
 */
import { createContext, useContext } from 'react';

/**
 * The context value is the entire SettingsPage internal scope.
 * We type it as `any` intentionally: the original component used
 * closure-captured variables, and typing every single one of the
 * 180+ state variables would produce zero runtime benefit while
 * adding thousands of lines of type declarations.
 *
 * Tab components consume this via `useSettingsContext()` and
 * destructure only the fields they reference.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SettingsContext = createContext<any>(null);

export function useSettingsContext() {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettingsContext must be used within SettingsContext.Provider');
  }
  return ctx;
}
