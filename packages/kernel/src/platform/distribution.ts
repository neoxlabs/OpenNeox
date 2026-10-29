/**
 * Distribution identity. Everything that would collide when two Neox
 * distributions run on the same machine comes from here: the user data
 * directory, the folder task outputs are written to (~/OpenNeox/Work, …), the
 * Electron app name (and with it userData, machine-id and the single-instance
 * lock), the deep-link protocol, the Windows AppUserModelId and the local server
 * port.
 *
 * OpenNeox uses its own values so it can run side by side with other Neox
 * builds without sharing sign-in state, settings or session databases.
 * It has no update feed: builds update through your own release process.
 * It never contacts Neox Labs servers on its own: no crash reports, no network
 * probes, no version checks.
 */
export interface Distribution {
  id: string;
  appName: string;
  homeDirname: string;
  userRootDirname: string;
  protocol: string;
  appUserModelId: string;
  serverPort: number;
  autoUpdate: boolean;
  officialServices: boolean;
}

export const DISTRIBUTION: Distribution = {
  id: 'openneox',
  appName: 'OpenNeox',
  homeDirname: '.neox-open',
  userRootDirname: 'OpenNeox',
  protocol: 'openneox',
  appUserModelId: 'dev.neoxlabs.openneox',
  serverPort: 4419,
  autoUpdate: false,
  officialServices: false,
};
