# Contributing to OpenNeox

Thanks for helping improve OpenNeox. Changes should be small enough to review,
documented when they alter user-visible behavior, and covered by focused tests.

## Development setup

```bash
npm ci
npm run type-check
npm run check:boundaries
npm run check:specifiers
npm run check:licenses
npm test
```

## Pull requests

- Explain the behavior change and the validation you ran.
- Keep application-to-package dependencies moving inward; packages must not
  import from `apps`.
- Do not add hosted service URLs, credentials, fixed OAuth client IDs, generated
  output, signing files, or private deployment configuration.
- Preserve third-party licenses. In particular, the vendored Ink package remains
  MIT-licensed.
- Update user documentation and tests when a public command, API, or workflow
  changes.

Use clear commit messages and avoid unrelated formatting or dependency churn.

## Comments and public documentation

Comments should explain what the code does and why the design requires it.
Keep them factual and durable: do not include dates, user quotations, internal
process notes, emojis, or descriptions of code as copied from another product.
Name an external project only when documenting a real protocol or file-format
compatibility requirement. Run `node scripts/audit-comments.mjs --summary`
before submitting comment-only changes and keep third-party attribution in
`NOTICE` and the relevant package documentation.

## License and contributions

By submitting a contribution, you agree that it may be distributed under the
Apache License, Version 2.0, as described in [LICENSE](LICENSE), unless a
separate written agreement says otherwise. Third-party files remain under their
own licenses.
