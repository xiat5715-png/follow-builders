# Pharma and AI4S Intelligence

This workflow produces a daily Chinese intelligence digest covering:

- China and overseas pharmaceutical companies
- Commercial deals, financing, M&A, licensing, and strategy
- R&D, clinical trials, approvals, and regulatory events
- CRO, CDMO, manufacturing, and supply chain companies
- Executive, scientific leader, and key researcher moves or viewpoints
- AI4S and AI-enabled biopharma companies
- Foundation models for biology, omics, single-cell, virtual cells, aging clocks,
  protein design, drug discovery, and laboratory automation

## Sources

The default collector uses bilingual Google News RSS queries, Europe PMC,
bioRxiv, podcast RSS feeds discovered through the Apple Podcasts directory, and
the source URLs contained in those records. Source configuration lives in
`config/pharma-intelligence-sources.json`.

X is optional and requires `X_BEARER_TOKEN`. Arbitrary WeChat public-account
search does not have a stable public API. Compliant WeChat RSS, RSSHub, company
feeds, or paid media feeds can be added through `customFeeds` or the
`PHARMA_EXTRA_FEEDS_JSON` secret.

## Secrets

Required:

- `DEEPSEEK_API_KEY`
- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`, unless a separate `PHARMA_NOTION_DATABASE_ID` is set

Optional:

- `PHARMA_NOTION_DATABASE_ID`: publish to a separate pharma database
- `X_BEARER_TOKEN`: enable recent X search
- `PHARMA_EXTRA_FEEDS_JSON`: JSON array of additional RSS feed definitions

Example extra feed value:

```json
[
  {
    "name": "Example WeChat RSS",
    "url": "https://example.com/feed.xml",
    "type": "wechat",
    "bucket": "china",
    "language": "zh"
  }
]
```

The workflow runs daily at 08:30 Asia/Shanghai and can be triggered manually.
