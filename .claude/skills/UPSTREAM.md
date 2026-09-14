# UPSTREAM: marketingskills (stripped subset)

Source: https://github.com/coreyhaines31/marketingskills at commit `5b2c0007766c6a1cf1d53fd8fc73e979e0821022` (2026-09-04), MIT licence (`LICENSE.marketingskills` beside this file).
Installed by `hooks/install-marketing-pack.mjs` from randommonicle/claude-skills; re-run it to
reinstall or to change the set. Do not edit the installed skills in place: edits are lost on the
next run. To change one, change it upstream or fork it out of this list.

A domain pack installs per project, stripped, with this provenance file; never user-level and
never into the guardrail library (its DECISIONS.md, 2026-09-14).

## Installed

- `product-marketing`
- `copywriting`
- `copy-editing`
- `cro`
- `seo-audit`
- `site-architecture`
- `schema`
- `ai-seo`
- `content-strategy`
- `pricing`
- `emails`
- `analytics`
- `customer-research`
- `offers`

## Cuts

Dropped from every kept skill: `evals/`, the `## Tool Integrations` section (vendor registry),
every line linking `tools/integrations/` or `tools/REGISTRY.md`, and Related Skills rows naming a
skill that is not installed. Line numbers are the upstream file's at the pinned commit. Prose
mentions of uninstalled skills outside those rows are left as written.

### product-marketing

No cuts.

### copywriting

- `SKILL.md:255` (related row: popups not installed): `- **popups**: For popup and modal copy`
- `SKILL.md:256` (related row: ab-testing not installed): `- **ab-testing**: To test copy variations`

### copy-editing

- `SKILL.md:445` (related row: marketing-psychology not installed): `- **marketing-psychology**: For understanding why certain edits improve conversion`
- `SKILL.md:446` (related row: ab-testing not installed): `- **ab-testing**: For testing copy variations`

### cro

- `SKILL.md:178` (related row: signup not installed): `- **signup**: If the issue is in the signup process itself`
- `SKILL.md:179` (related row: popups not installed): `- **popups**: If considering popups as part of the strategy`
- `SKILL.md:181` (related row: ab-testing not installed): `- **ab-testing**: To properly test recommended changes`

### seo-audit

- `SKILL.md:495` (related row: programmatic-seo not installed): `- **programmatic-seo**: For building SEO pages at scale`

### site-architecture

- `SKILL.md:353` (related row: programmatic-seo not installed): `- **programmatic-seo**: For building SEO pages at scale with templates and data`
- `SKILL.md:357` (related row: competitors not installed): `- **competitors**: For comparison page frameworks and URL patterns`

### schema

- `SKILL.md:178` (related row: programmatic-seo not installed): `- **programmatic-seo**: For templated schema at scale`

### ai-seo

- `SKILL.md:457` (tools section): `## Tool Integrations`
- `SKILL.md:459` (tools section): `For implementation, see the [tools registry](../../tools/REGISTRY.md).`
- `SKILL.md:461` (tools section): `| Tool | Use For |`
- `SKILL.md:462` (tools section): `|------|---------|`
- `SKILL.md:463` (tools section): `| 'semrush' | AI Overview tracking, keyword research, content gap analysis |`
- `SKILL.md:464` (tools section): `| 'ahrefs' | Backlink analysis, content explorer, AI Overview data |`
- `SKILL.md:465` (tools section): `| 'gsc' | Search Console performance data, query tracking |`
- `SKILL.md:466` (tools section): `| 'ga4' | Referral traffic from AI sources |`
- `SKILL.md:486` (related row: competitors not installed): `- **competitors**: For building comparison pages that get cited`
- `SKILL.md:487` (related row: programmatic-seo not installed): `- **programmatic-seo**: For building SEO pages at scale`

### content-strategy

- `SKILL.md:435` (related row: programmatic-seo not installed): `- **programmatic-seo**: For scaled content generation`
- `SKILL.md:438` (related row: social not installed): `- **social**: For social media content, content atomization, and repurposing execution`
- `SKILL.md:439` (related row: launch not installed): `- **launch**: For the ORB channel-type playbook and launch-day distribution`
- `references/headless-cms.md:192` (registry link): `- [Sanity](../../../tools/integrations/sanity.md) — GROQ queries, mutations, CLI`
- `references/headless-cms.md:193` (registry link): `- [Contentful](../../../tools/integrations/contentful.md) — Delivery/Management APIs, publishing`
- `references/headless-cms.md:194` (registry link): `- [Strapi](../../../tools/integrations/strapi.md) — REST CRUD, filters, document API`

### pricing

- `SKILL.md:287` (related row: churn-prevention not installed): `- **churn-prevention**: For cancel flows, save offers, and reducing revenue churn`
- `SKILL.md:292` (related row: marketing-psychology not installed): `- **marketing-psychology**: For pricing psychology principles`
- `SKILL.md:293` (related row: ab-testing not installed): `- **ab-testing**: For testing pricing changes`
- `SKILL.md:294` (related row: revops not installed): `- **revops**: For deal desk processes and pipeline pricing`
- `SKILL.md:295` (related row: sales-enablement not installed): `- **sales-enablement**: For proposal templates and pricing presentations`

### emails

- `SKILL.md:288` (tools section): `## Tool Integrations`
- `SKILL.md:290` (tools section): `For implementation, see the [tools registry](../../tools/REGISTRY.md). Key email tools:`
- `SKILL.md:292` (tools section): `| Tool | Best For | MCP | Guide |`
- `SKILL.md:293` (tools section): `|------|----------|:---:|-------|`
- `SKILL.md:294` (tools section): `| **Customer.io** | Behavior-based automation | - | [customer-io.md](../../tools/integrations/customer-io.md) |`
- `SKILL.md:295` (tools section): `| **Mailchimp** | SMB email marketing | ✓ | [mailchimp.md](../../tools/integrations/mailchimp.md) |`
- `SKILL.md:296` (tools section): `| **Nitrosend** | AI-native email (sequences via prompts) | ✓ | [nitrosend.md](../../tools/integrations/nitrosend.md) |`
- `SKILL.md:297` (tools section): `| **Resend** | Developer-friendly transactional | ✓ | [resend.md](../../tools/integrations/resend.md) |`
- `SKILL.md:298` (tools section): `| **SendGrid** | Transactional email at scale | - | [sendgrid.md](../../tools/integrations/sendgrid.md) |`
- `SKILL.md:299` (tools section): `| **Kit** | Creator/newsletter focused | - | [kit.md](../../tools/integrations/kit.md) |`
- `SKILL.md:305` (related row: lead-magnets not installed): `- **lead-magnets**: For planning lead magnets that feed into nurture sequences`
- `SKILL.md:306` (related row: churn-prevention not installed): `- **churn-prevention**: For cancel flows, save offers, and dunning strategy (email supports this)`
- `SKILL.md:307` (related row: onboarding not installed): `- **onboarding**: For in-app onboarding (email supports this)`
- `SKILL.md:309` (related row: ab-testing not installed): `- **ab-testing**: For testing email elements`
- `SKILL.md:310` (related row: popups not installed): `- **popups**: For email capture popups`
- `SKILL.md:311` (related row: revops not installed): `- **revops**: For lifecycle stages that trigger email sequences`

### analytics

- `SKILL.md:290` (tools section): `## Tool Integrations`
- `SKILL.md:292` (tools section): `For implementation, see the [tools registry](../../tools/REGISTRY.md). Key analytics tools:`
- `SKILL.md:294` (tools section): `| Tool | Best For | MCP | Guide |`
- `SKILL.md:295` (tools section): `|------|----------|:---:|-------|`
- `SKILL.md:296` (tools section): `| **GA4** | Web analytics, Google ecosystem | ✓ | [ga4.md](../../tools/integrations/ga4.md) |`
- `SKILL.md:297` (tools section): `| **Mixpanel** | Product analytics, event tracking | - | [mixpanel.md](../../tools/integrations/mixpanel.md) |`
- `SKILL.md:298` (tools section): `| **Amplitude** | Product analytics, cohort analysis | - | [amplitude.md](../../tools/integrations/amplitude.md) |`
- `SKILL.md:299` (tools section): `| **PostHog** | Open-source analytics, session replay | - | [posthog.md](../../tools/integrations/posthog.md) |`
- `SKILL.md:300` (tools section): `| **Segment** | Customer data platform, routing | - | [segment.md](../../tools/integrations/segment.md) |`
- `SKILL.md:306` (related row: ab-testing not installed): `- **ab-testing**: For experiment tracking`
- `SKILL.md:307` (related row: attribution not installed): `- **attribution**: For attribution models, multi-touch/MMM/incrementality, and reconciling conflicting numbers across to`
- `SKILL.md:310` (related row: revops not installed): `- **revops**: For pipeline metrics, CRM tracking, and revenue attribution`

### customer-research

- `SKILL.md:299` (related row: competitors not installed): `| Building a competitor comparison page | 'competitors' |`
- `SKILL.md:300` (related row: churn-prevention not installed): `| Creating a churn prevention strategy from churn research | 'churn-prevention' |`
- `SKILL.md:301` (related row: ads not installed): `| Planning paid ads informed by research | 'ads' |`
- `SKILL.md:302` (related row: cold-email not installed): `| Writing cold email using research on pain/trigger | 'cold-email' |`
- `SKILL.md:303` (related row: prospecting not installed): `| Translating customer research into an ICP for outbound | 'prospecting' |`
- `SKILL.md:305` (related row: marketing-plan not installed): `| Rolling research into a comprehensive marketing plan | 'marketing-plan' |`
- `references/source-guides.md:336` (registry link): `See [tools/integrations/sparktoro.md](../../../tools/integrations/sparktoro.md) for full tool details and pricing.`

### offers

- `SKILL.md:151` (related row: launch not installed): `- **launch** — for the moment you ship the offer`
- `SKILL.md:152` (related row: paywalls not installed): `- **paywalls** — for in-app upgrade-prompt versions of an offer`
- `SKILL.md:153` (related row: sales-enablement not installed): `- **sales-enablement** — for the deck and one-pager that carry the offer into a sales conversation`
- `SKILL.md:155` (related row: marketing-psychology not installed): `- **marketing-psychology** — for the cognitive biases that make offers land or bounce`

## House rules in front of these skills

Copy produced through these skills gets `unslop-text` as the final pass (the pack is written in the
register that skill strips, em dashes included). Any customer-facing claim, statistic or
certification goes through `substantiate-outward-claims` before it ships.
