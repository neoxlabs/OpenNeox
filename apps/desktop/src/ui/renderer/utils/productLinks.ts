/**
 * productLinks — every "open the website / docs / feedback" link in the app.
 * The open-source build points them all at the OpenNeox repository.
 */

const REPO = 'https://github.com/neoxlabs/OpenNeox';

export const productLinks = {
  website: REPO,
  docs: `${REPO}#readme`,
  changelog: `${REPO}/releases`,
  feedback: `${REPO}/issues/new`,
  privacy: `${REPO}/blob/main/SECURITY.md`,
  terms: `${REPO}/blob/main/LICENSE`,
  github: REPO,
  githubReleases: `${REPO}/releases`,
};
