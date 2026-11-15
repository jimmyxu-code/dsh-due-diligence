# Architecture

## Overview

The package is a Host-only DSH bundle. `cordis.patch.yml` declares the `dd`
agent preset, and the preset mounts the package in its own tool scope. The
`index.js` entry registers five `dd_*` tool definitions with
`ctx.tools.register()`.

There is no client bundle, background daemon, Python sidecar, MCP server or
runtime package dependency.

## Module map

| File | Responsibility |
| --- | --- |
| `index.js` | Reads optional report-directory configuration and registers tools. |
| `lib/tool-defs.mjs` | Tool schemas, argument validation, output envelopes, renderers and execution adapters. |
| `lib/http.mjs` | Fetch wrapper with User-Agent, timeout, caller cancellation, response limits, concurrency pool and retry. |
| `lib/evidence.mjs` | Evidence creation, confidence helpers, de-duplication and public HTML metadata extraction. |
| `lib/sherlock-engine.mjs` | Native Node.js implementation of Sherlock site selection, requests and judgment rules. |
| `lib/username.mjs` | Username scan orchestration, truncation, second-pass verification and result counts. |
| `lib/name.mjs` | Wikidata entity/alias lookup and guided people-profile web queries. |
| `lib/company.mjs` | GLEIF, SEC EDGAR and Wikidata company candidates plus permitted deep links. |
| `lib/domain.mjs` | crt.sh, Wayback and RDAP adapters with independent soft failures. |
| `lib/report.mjs` | Markdown report generation and local file output. |

## Execution model

The tool definitions return plain JSON-compatible values. Unexpected network or
source errors become structured soft failures rather than terminating the agent
turn. Caller cancellation is forwarded through `exec.signal` to in-flight work.

The username scanner is intentionally different from the other adapters: it
uses higher bounded concurrency for many independent site probes. Source APIs
use smaller pools, request timeouts and conservative retry behavior.

## Evidence and output

Every tool returns a common envelope:

```json
{
  "ok": true,
  "tool": "dd_domain",
  "query": {},
  "summary": "...",
  "evidence": [
    {
      "source": "rdap",
      "url": "https://...",
      "fetched_at": "2026-01-01T00:00:00.000Z",
      "confidence": "high",
      "detail": "..."
    }
  ],
  "warnings": [],
  "error": null
}
```

Tool-specific fields are additive. Output schemas intentionally keep long-tail
source structures open so a nonessential upstream field change does not break
the whole call.

## Tool boundary

The preset declares web search/fetch and the five plugin tools. It does not
declare shell, filesystem, jobs, delegation, workflow, task or plugin-manager
tools. DSH profiles may independently contribute global tools; this plugin does
not rewrite or filter the host's global tool registry.

## Sherlock provenance

`data/sherlock-sites.json` and `data/false-positive-exclusions.txt` are pinned
snapshots from Sherlock v0.16.2. The native engine adapts the public judgment
rules and documents implementation differences in its source comments. The
upstream MIT notice is retained in `data/SHERLOCK-LICENSE.txt`.
