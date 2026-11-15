# dsh-due-diligence

[![CI](https://github.com/jimmyxu-code/dsh-due-diligence/actions/workflows/ci.yml/badge.svg)](https://github.com/jimmyxu-code/dsh-due-diligence/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](package.json)

**中文文档：[README.zh.md](README.zh.md)**

An open-source **Due Diligence agent preset** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It researches **people, usernames, companies and domains** using free public sources, keeps source URLs and confidence labels attached to claims, and writes structured Markdown reports.

The people workflow is **profile-first**, not just “does this account exist?”: it combines Wikidata, guided web research and public profile metadata into basics, occupation, education, works, media, accounts, timeline and risk sections.

## Features

- **People profiles** — real names, aliases and public biographies; guided `web_search` / `web_fetch` research.
- **Username discovery** — a native Node.js engine using the bundled Sherlock v0.16.2 site rules, with false-positive exclusions, WAF handling and optional second-pass verification.
- **Company lookup** — GLEIF LEI records, SEC EDGAR CIK/submissions and Wikidata candidates. Chinese commercial/registry sites are deep links only, never scraped.
- **Domain reconnaissance** — crt.sh certificates, Wayback snapshots and RDAP registration data with per-source graceful degradation.
- **Evidence envelopes** — every tool returns `source`, `url`, `fetched_at`, `confidence` and `detail`.
- **Markdown reports** — optional profile chapters, evidence tables, open questions, next steps and a compliance statement.
- **Zero runtime dependencies** — plain ESM and Node.js built-ins; no Python, API keys, paid accounts or browser automation.

## Requirements

- DeepSeek Harness **0.2.2-rc.1** (tested version)
- Node.js **22+** for local development; tested with **24.21.0**
- Network access to the public data sources you use

## Install

No `npm install` or build step is required.

```bash
git clone https://github.com/jimmyxu-code/dsh-due-diligence.git
```

In a DSH session with plugin-management permission:

```text
plugin_manager({
  action: "install_bundle",
  target: "/absolute/path/to/dsh-due-diligence"
})
```

You can also use **Plugins → Add plugin** and select the local directory. After installation or an upgrade, start a **new session** and choose **背调 / Due diligence**. A running DSH host may need one restart to load changed JavaScript modules.

To remove the bundle:

```text
plugin_manager({ action: "remove_bundle", target: "dsh-due-diligence" })
```

Existing sessions keep the preset revision they started with. The plugin does not modify other presets or install local shell/file tools.

## Tools

| Tool | Purpose |
| --- | --- |
| `dd_name` | Wikidata candidates and aliases, search links and ready-to-use `web_queries` for a people-profile workflow. |
| `dd_username` | Username discovery across the bundled Sherlock site rules; optional verification also captures public page titles and meta descriptions. |
| `dd_company` | GLEIF, SEC EDGAR and Wikidata candidates with jurisdiction/status and next steps. |
| `dd_domain` | crt.sh, Wayback and RDAP evidence with independent source failures. |
| `dd_report` | Writes a Markdown report, including optional people-profile sections. |

Example prompts in a new Due Diligence session:

```text
Research Sam Altman and produce a sourced public people profile.
Check the username sherlock with verification enabled.
Look up Apple and identify its SEC CIK and GLEIF candidates.
Inspect example.com using certificates, archives and RDAP.
Turn the findings into a report.
```

The preset supplies `web_search` and `web_fetch` alongside the five `dd_*` tools. It declares **no bash, filesystem, jobs, subagent, workflow or plugin-manager tools**. Tools contributed globally by your own DSH profile are a separate concern and may still be visible.

## Configuration

Reports default to `~/Desktop/背调报告/`.

| Setting | Purpose |
| --- | --- |
| `DSH_DD_REPORT_DIR` | Overrides the report directory for the host process. |
| `DSH_DD_SEC_CONTACT` | Contact email or project URL inserted into the SEC User-Agent. Defaults to this repository's issue page. |
| `reportDir` in the `tool-dd` preset row | Per-preset report directory; takes precedence over the environment variable. |

Example for a host launched from a shell:

```bash
export DSH_DD_REPORT_DIR="$HOME/Reports/due-diligence"
export DSH_DD_SEC_CONTACT="you@example.com"
```

Do not put credentials, API keys or private data in `cordis.patch.yml` or tracked files.

## Responsible use

Use this plugin only for lawful, authorized research and public-source verification.

- Do not use it for harassment, stalking, doxxing, discrimination or automated decisions about people.
- Do not use leaked credential databases, bypass paywalls, impersonate others or scrape platforms that prohibit it.
- LinkedIn, X/Twitter, Instagram, Facebook, GSXT and Chinese commercial registry sites are **not scraped**.
- Sensitive personal data is out of scope. Public professional, organizational, educational and account information should still be handled under applicable privacy law.
- Reports are not consumer reports, legal/investment/employment advice, or a substitute for human verification.

See [SECURITY.md](SECURITY.md) and [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md).

## Development

```bash
npm run check:all   # syntax-check the host, modules and tests
npm test            # unit tests; mocked fetch, no real network required
npm run pack:dry-run
```

The test suite covers Sherlock judgment rules, verification, source adapters, output envelopes, report generation and preset boundaries. Network acceptance tests are optional and must not be part of the default unit-test run.

## Repository layout

```text
index.js                 # Host entry: registers the five tools
cordis.patch.yml         # Due Diligence preset, persona and compaction
lib/                     # Pure ESM engines, adapters and tool definitions
data/                    # Sherlock rules, exclusions and upstream license
locale/                  # Plugin Manager metadata
test/                    # Offline unit tests
docs/                    # Architecture, sources and verification notes
```

## License and notices

MIT for this project. Bundled Sherlock data and adapted judgment logic retain the upstream MIT notice; see [LICENSE](LICENSE), [NOTICE](NOTICE) and [data/SHERLOCK-LICENSE.txt](data/SHERLOCK-LICENSE.txt).

Public data sources have their own terms. This project performs low-frequency, single-user queries and does not grant any additional rights to third-party data.
