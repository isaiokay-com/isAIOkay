# Search and social metadata

The primary search intent is current developer experience with AI coding models, especially result quality, usage efficiency, and whether a model appears improved, stable, or degraded over time.

The homepage targets **AI coding models** and **AI coding model rankings**. Its title, description, H1, Open Graph/social-card metadata, and `WebPage`/`Dataset` structured data share that positioning so the search snippet and landing-page promise stay aligned.

## Implemented

- One canonical URL per server-rendered page, with ranking query parameters canonicalized to `/`.
- Model-focused page titles and descriptions.
- Canonical provider/model pages at `/{provider}/{model}` with current evidence, daily score history, catalog-added dates, and model-specific Dataset structured data.
- Open Graph and X large-image cards use the cache-busted 1200×630 `/og-ai-coding-model-rankings.png` asset generated from the editable `/og.svg` source.
- `WebSite`, `Dataset`, and opt-in `ProfilePage` structured data.
- `robots.txt` blocks API, administration, and CLI utility routes.
- `sitemap.xml` lists the stable public utility, legal routes, and every active model page from the catalog.
- Private profiles return `noindex,nofollow`; opted-in profiles are indexable.
- SVG, PNG, Apple touch, and web-manifest icon coverage.

Public profile URLs are intentionally omitted from the static sitemap because usernames are mutable and profiles are private by default. Search engines can discover opted-in profiles through user-shared links without exposing a directory of accounts.

## Content boundary

Model pages are generated only for active catalog entries and only from real catalog metadata, rating aggregates, and documented dates. They do not invent summaries, backfill trend points, or present reported developer experience as an objective benchmark. A model without eligible history shows a transparent collecting state rather than placeholder data.
