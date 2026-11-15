# Security and responsible disclosure

## Reporting a vulnerability

Please use GitHub private vulnerability reporting:

https://github.com/jimmyxu-code/dsh-due-diligence/security/advisories/new

Do not include real investigation targets, private reports, credentials,
cookies or API keys in an issue. Provide a minimal synthetic reproduction and
state the affected version and DSH release.

## Data handled by the plugin

The plugin makes outbound requests to public OSINT/data endpoints and to
username/profile URLs derived from the user's query. `web_search` and
`web_fetch` are supplied by DSH and have their own provider behavior.

The plugin does not require API keys, paid accounts, cookies or login state.
It does not intentionally collect passwords, private addresses, government IDs,
private phone numbers, payment data or leaked credential databases.

Reports are written locally by `dd_report`, by default under
`~/Desktop/背调报告/`. Treat those reports as potentially sensitive and do not
commit them to a public repository.

## Responsible use

This project is for lawful, authorized public-source research. It is not a
consumer-reporting service and must not be used for harassment, stalking,
doxxing, discrimination or automated employment/credit decisions.

Platform terms and privacy law apply in addition to this project's MIT license.
The license is not permission to scrape a service or to process personal data
without a lawful basis.
