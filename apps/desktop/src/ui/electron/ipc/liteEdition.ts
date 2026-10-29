/**
 * Edition entry point for the pure-Node lite backend (see liteBridgeBootstrap.ts).
 * The Electron main process uses ../mainEdition.ts instead.
 *
 * The public build registers nothing here: remote (cloud) sessions stay
 * unavailable and every session runs locally (see ../remoteSessions.ts).
 * Anything registered here must be loadable without Electron.
 */
export function registerLiteEdition(): void {
  /* The public build has no edition-specific services. */
}
