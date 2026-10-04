export type ColorTheme =
  | 'violet'
  | 'gold'
  | 'pink'
  | 'blue'
  | 'green'
  | 'purple'
  | 'orange'
  | 'red'
  | 'cyan'
  | 'indigo'
  | 'teal';

export type DarkModePreference =
  | 'dark'
  | 'light'
  | 'auto'
  | 'midnight'
  | 'high-contrast';

export interface UILastState {
  lastWorkspace?: string;
  lastModelId?: string;
  theme: 'dark' | 'light';
  darkModePreference?: DarkModePreference;
  colorTheme?: ColorTheme;
  /** Legacy one-click preset. Renderer only uses it to migrate old state to themePackId. */
  themePreset?: string;
  /** Source-of-truth theme pack id for the unified theme pipeline. */
  themePackId?: string;
  onboardingCompleted?: boolean;
  workspaces: Array<{
    path: string;
    name: string;
    lastOpened: number;
    lastSessionId?: string;
  }>;
}
