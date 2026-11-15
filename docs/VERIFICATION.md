# Verification

## Required offline checks

Run these before every release:

```bash
npm run check:all
npm test
npm run pack:dry-run
```

The default test suite is offline. It uses injected mock `fetch` functions and
fixtures, so it can run in CI without credentials or access to target sites.

Current suite coverage includes:

- Sherlock `status_code`, `message` and `response_url` judgments
- `errorCode`, `errorMsg`, regex filtering, exclusions and NSFW filtering
- WAF handling, second-pass verification and cancellation
- GLEIF, SEC, Wikidata, crt.sh, Wayback and RDAP response parsing
- Source failures, retries and malformed inputs
- Tool schemas, output envelopes and model-facing rendering
- Markdown reports, including optional people-profile sections
- Preset composition and the absence of local execution tool declarations
- A regression guard against registry-event/restriction feedback loops

## Optional live checks

Live checks are not part of `npm test`. Run them sparingly, against public
example targets, and never as a load test. Record:

- DSH and Node.js versions
- The exact new-session preset used
- Tool names and arguments (without secrets)
- Whether the expected evidence/source appeared
- Failures, timeouts and any manual follow-up needed

Do not commit raw transcripts, private reports, local profile backups or
machine-specific paths. Publish only sanitized summaries when useful.

## Package checks

Before pushing a release tag:

1. Confirm `package.json` has no `private: true` and no runtime dependencies.
2. Inspect `npm pack --dry-run` output for unintended files.
3. Confirm `LICENSE`, `NOTICE`, both READMEs and `data/SHERLOCK-LICENSE.txt`
   are present.
4. Search tracked files for credentials, private absolute paths and acceptance
   artifacts.
5. Install a clean checkout in a disposable DSH profile, then create a new Due
   Diligence session and verify the five `dd_*` tools are available.

A linked local bundle does not apply the npm `files` filter, so the packed file
list and the repository file list must be reviewed separately.
