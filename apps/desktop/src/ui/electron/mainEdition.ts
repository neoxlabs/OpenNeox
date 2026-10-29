/**
 * Main-process edition entry point. This is the only file in the Electron main
 * process that differs between editions (its renderer twin is
 * renderer/modules/shell/editionSlots.ts).
 *
 * The public build registers only the plugin marketplace here:
 *   - remote (cloud) sessions stay unavailable, so every session runs locally
 *     (see remoteSessions.ts);
 *   - plugins come from the Neox plugin marketplace (browsing and downloads need
 *     no account; it is only contacted while the Plugins page is open), or from
 *     local folders, URLs, .neox-plugin packages and GitHub-source marketplaces.
 *
 * A distribution that ships extra services replaces the two function bodies:
 * registerMainEdition() connects its implementations to the shared hooks
 * (registerRemoteSessionTransport, registerPluginInstallSource,
 * registerPluginSubcommand), and registerMainEditionIpc() registers its own
 * IPC channels after the shared handlers.
 *
 * Callers: ipc/registerAllIpcHandlers.ts calls registerMainEdition() first and
 * registerMainEditionIpc() last. The pure-Node lite backend uses
 * ipc/liteEdition.ts instead.
 */
import {
  registerOfficialMarketplace,
  registerOfficialMarketplaceIpc,
} from '../../plugins/marketplace/registerOfficialMarketplace.js';

export function registerMainEdition(): void {
  registerOfficialMarketplace();
}

export function registerMainEditionIpc(): void {
  registerOfficialMarketplaceIpc();
}
