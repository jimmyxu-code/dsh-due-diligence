# Data sources and boundaries

All directly integrated sources are free to query without a paid API key.
Availability, rate limits and terms can change; callers must comply with the
current provider terms.

## Direct public sources

| Source | Used by | Purpose | Notes |
| --- | --- | --- | --- |
| GLEIF API | `dd_company` | LEI fuzzy candidates and LEI records | No key required. |
| SEC EDGAR full-text search and submissions | `dd_company` | CIK candidates and filing-entity details | Sends an identifying User-Agent; `DSH_DD_SEC_CONTACT` can set the contact value. Keep request rates within SEC guidance. |
| Wikidata API | `dd_name`, `dd_company` | Entity candidates and aliases | Candidates are leads, not identity proof. |
| crt.sh | `dd_domain` | Certificate Transparency entries and related names | Occasional 502 responses are expected; retry once and degrade softly. |
| Wayback availability API | `dd_domain` | Closest available archived snapshot | No snapshot is a valid result, not necessarily an outage. |
| rdap.org | `dd_domain` | Registration data, registrar, dates, status and nameservers | Unsupported TLDs or missing records degrade softly. |
| Bundled Sherlock rules | `dd_username` | Public profile URL existence checks | v0.16.2 snapshot; rules age and some sites produce false positives. |
| Public profile pages | `dd_username` with `verify=true` | Reachability plus page title/meta description | No login, private content or browser automation. |
| `web_search` / `web_fetch` | People and contextual research | Public web results and page content | Provided by DSH, subject to the configured provider and target-site terms. |

## Deep links only

The plugin does not scrape these sources. Where appropriate it may construct a
link for manual inspection:

- LinkedIn, X/Twitter, Instagram and Facebook
- 天眼查, 企查查, 爱企查 and GSXT
- 裁判文书网 and other restricted court/registry sites

Do not add fetchers or browser automation for these sources to this project.

## Not in scope

- Commercial company-data APIs and required paid keys
- Email, phone, face recognition or identity-document lookup
- Leaked credential or “social engineering” databases
- Paywall/login bypass, impersonation or CAPTCHA avoidance
- Automated employment, credit, housing or similar decisions about people

## Privacy and evidence quality

A URL returning HTTP 200 is not proof that an account belongs to a particular
person. Wikidata labels and aliases are disambiguation leads. Confidence labels
are judgments about evidence strength, not permission to publish sensitive
information.

Reports should include source URLs and timestamps, preserve uncertainty and be
reviewed by a human before consequential use.
