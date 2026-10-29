# Status and Open Threads

A snapshot for whoever picks this up next.

This is a working status file, not a specification. Anything listed as open here
has *not* been designed unless a linked document says otherwise.

## Where things stand

**Comment pass — done.** `npm run audit:comments` is a gate and passes at zero.
It rejects comments that describe the edit rather than the code ("changed X to
Y", "the one above"), and comments that carry private provenance. Write comments
that explain the constraint, not the history.

**Edition split — done.** Hosted capabilities sit behind the contract in
`packages/cloud`, whose default implementation is a disabled no-op. There is no
`commercial/` directory in this repo and there should not be one.

## Open threads

**README screenshots.** The README carries the brand lockup and the capability
tables, but no recording of a terminal session yet.

**npm publishing.** Packages are not published to npm yet; the CLI is built from
source.

## Conventions worth knowing before the first commit

- Comments state the constraint that makes the code what it is. They never
  describe the change, reference a previous version, or name an external product
  as the reason for a design. The audit gate enforces this.
- Behaviour changes get a focused test. The gates exist because each one caught
  a real regression.
- Verify terminal UI changes in a real terminal (tmux works well for capturing
  frames) rather than reasoning from the source.
