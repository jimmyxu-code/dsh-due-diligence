# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-11-15

### Changed

- Prepared the plugin for public open-source distribution.
- Replaced machine-specific documentation and acceptance artifacts with
  portable English and Chinese documentation.
- Added package metadata, MIT license, notices, contribution/security guides
  and GitHub Actions CI.
- Made the SEC contact value configurable through `DSH_DD_SEC_CONTACT`; the
  default is the public repository issue page.
- Updated the public User-Agent to version 0.2.1.

### Verified

- Offline unit suite: 127 tests.
- Syntax checks for the host entry, all library modules and all tests.

## [0.2.0] - 2026-11-07

### Added

- Profile-first people research workflow in the Due Diligence preset.
- Wikidata aliases and guided `web_queries` in `dd_name`.
- Public page titles and meta descriptions in verified `dd_username` results.
- Optional `profile` sections in `dd_report`.

### Changed

- Kept tool registration minimal and avoided registry-event/tool-restriction
  feedback loops.

## [0.1.0] - 2026-11-07

### Added

- Initial Due Diligence agent preset with five tools:
  `dd_username`, `dd_name`, `dd_company`, `dd_domain` and `dd_report`.
- Native Node.js Sherlock engine and bundled v0.16.2 rules.
- GLEIF, SEC EDGAR, Wikidata, crt.sh, Wayback and RDAP adapters.
- Evidence envelopes with source, timestamp and confidence.
- Offline unit tests and Markdown report generation.

[0.2.1]: https://github.com/jimmyxu-code/dsh-due-diligence/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jimmyxu-code/dsh-due-diligence/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jimmyxu-code/dsh-due-diligence/releases/tag/v0.1.0
