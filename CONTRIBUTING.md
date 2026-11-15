# Contributing

Thanks for improving dsh-due-diligence.

## Ground rules

- Keep the plugin free of runtime dependencies unless a change has a clear,
  reviewed reason to add one.
- Do not add paid-only sources, required API keys, login state, browser
  automation, leaked-data sources or scraping of prohibited platforms.
- Do not commit credentials, private reports, real investigation transcripts,
  local absolute paths or machine-specific profile files.
- New network behavior must have timeouts, cancellation and graceful failure.
- Keep changes within public, documented DSH/Cordis interfaces.

## Development

Use Node.js 22 or newer (24 is the tested version):

```bash
npm run check:all
npm test
```

Unit tests must use fixtures or injected mock `fetch` implementations and must
not require real network access. Do not add stress tests or broad live scans to
the default suite.

## Changes to data sources

- Document the endpoint, authentication requirement, rate limits and license.
- Return evidence using the common envelope and confidence vocabulary.
- A failing source must not prevent other sources from returning results.
- Keep prohibited sources as deep links only.
- When updating Sherlock data, record the exact upstream version/commit and
  preserve `data/SHERLOCK-LICENSE.txt`.

## Tests and documentation

Add or update tests for behavior changes, including output-schema and preset
boundary changes. Update both README files when changing installation,
configuration, tool arguments, limitations or responsible-use guidance.

## Pull requests

Include:

1. The problem and intended behavior.
2. A concise implementation summary.
3. Test commands and results.
4. Any live-network verification performed separately from unit tests.
5. Privacy, licensing and compatibility impacts.

By contributing, you agree that your contributions are licensed under the MIT
License and that you have the right to submit them.
