# UPSTREAM: marketingskills (stripped subset)

Source: https://github.com/coreyhaines31/marketingskills at commit `88c79f6528a9347420e57ceb1fff9a60de651768` (2026-10-30), MIT licence (`LICENSE.marketingskills` beside this file).
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

- `SKILL.md:338` (related row: popups not installed): `- **popups**: For popup and modal copy`
- `SKILL.md:339` (related row: ab-testing not installed): `- **ab-testing**: To test copy variations`

### copy-editing

- `SKILL.md:479` (related row: marketing-psychology not installed): `- **marketing-psychology**: For understanding why certain edits improve conversion`
- `SKILL.md:480` (related row: ab-testing not installed): `- **ab-testing**: For testing copy variations`

### cro

- `SKILL.md:187` (related row: signup not installed): `- **signup**: If the issue is in the signup process itself`
- `SKILL.md:188` (related row: popups not installed): `- **popups**: If considering popups as part of the strategy`
- `SKILL.md:190` (related row: ab-testing not installed): `- **ab-testing**: To properly test recommended changes`

### seo-audit

- `SKILL.md:492` (related row: link-building not installed): `- **link-building**: For closing an authority gap with earned links and mentions`
- `SKILL.md:493` (related row: programmatic-seo not installed): `- **programmatic-seo**: For building SEO pages at scale`

### site-architecture

- `SKILL.md:354` (related row: programmatic-seo not installed): `- **programmatic-seo**: For building SEO pages at scale with templates and data`
- `SKILL.md:358` (related row: competitors not installed): `- **competitors**: For comparison page frameworks and URL patterns`
- `SKILL.md:359` (related row: launch not installed): `- **launch**: For site go-live QA after a build or migration`
- `references/platforms-and-migration.md:42` (registry link): `◆ marks a [Verified Partner](https://github.com/coreyhaines31/marketingskills/blob/main/tools/REGISTRY.md#verified-partn`

### schema

- `SKILL.md:190` (related row: programmatic-seo not installed): `- **programmatic-seo**: For templated schema at scale`

### ai-seo

- `SKILL.md:479` (tools section): `## Tool Integrations`
- `SKILL.md:481` (tools section): `For implementation, see the [tools registry](https://github.com/coreyhaines31/marketingskills/blob/main/tools/REGISTRY.m`
- `SKILL.md:483` (tools section): `| Tool | Use For |`
- `SKILL.md:484` (tools section): `|------|---------|`
- `SKILL.md:485` (tools section): `| 'semrush' | AI Overview tracking, keyword research, content gap analysis |`
- `SKILL.md:486` (tools section): `| 'ahrefs' | Backlink analysis, content explorer, AI Overview data |`
- `SKILL.md:487` (tools section): `| 'gsc' | Search Console performance data, query tracking |`
- `SKILL.md:488` (tools section): `| 'ga4' | Referral traffic from AI sources |`
- `SKILL.md:497` (related row: competitors not installed): `- **competitors**: For building comparison pages that get cited`
- `SKILL.md:498` (related row: programmatic-seo not installed): `- **programmatic-seo**: For building SEO pages at scale`
- `SKILL.md:500` (related row: lead-magnets not installed): `- **lead-magnets**: For packaging an owned course or content library as an installable agent skill (different from publi`
- `references/agent-readiness.md:79` (registry link): `- **Use your platform's support, if it has any.** Some site platforms and agent workflows add WebMCP for you. Ploy ◆, fo`

### content-strategy

- `SKILL.md:438` (related row: link-building not installed): `- **link-building**: For earning links to the content and the pages it supports`
- `SKILL.md:440` (related row: programmatic-seo not installed): `- **programmatic-seo**: For scaled content generation`
- `SKILL.md:443` (related row: social not installed): `- **social**: For social media content, content atomization, and repurposing execution`
- `SKILL.md:444` (related row: launch not installed): `- **launch**: For the ORB channel-type playbook and launch-day distribution`
- `references/headless-cms.md:192` (registry link): `- [Sanity](https://github.com/coreyhaines31/marketingskills/blob/main/tools/integrations/sanity.md) — GROQ queries, muta`
- `references/headless-cms.md:193` (registry link): `- [Contentful](https://github.com/coreyhaines31/marketingskills/blob/main/tools/integrations/contentful.md) — Delivery/M`
- `references/headless-cms.md:194` (registry link): `- [Strapi](https://github.com/coreyhaines31/marketingskills/blob/main/tools/integrations/strapi.md) — REST CRUD, filters`

### pricing

- `SKILL.md:287` (related row: churn-prevention not installed): `- **churn-prevention**: For cancel flows, save offers, and reducing revenue churn`
- `SKILL.md:292` (related row: marketing-psychology not installed): `- **marketing-psychology**: For pricing psychology principles`
- `SKILL.md:293` (related row: ab-testing not installed): `- **ab-testing**: For testing pricing changes`
- `SKILL.md:294` (related row: revops not installed): `- **revops**: For deal desk processes and pipeline pricing`
- `SKILL.md:295` (related row: sales-enablement not installed): `- **sales-enablement**: For proposal templates and pricing presentations`

### emails

- `SKILL.md:319` (tools section): `## Tool Integrations`
- `SKILL.md:321` (tools section): `For implementation, see the [tools registry](https://github.com/coreyhaines31/marketingskills/blob/main/tools/REGISTRY.m`
- `SKILL.md:323` (tools section): `| Tool | Best For | MCP | Guide |`
- `SKILL.md:324` (tools section): `|------|----------|:---:|-------|`
- `SKILL.md:325` (tools section): `| **Customer.io** | Behavior-based automation | - | [customer-io.md](https://github.com/coreyhaines31/marketingskills/bl`
- `SKILL.md:326` (tools section): `| **Mailchimp** | SMB email marketing | ✓ | [mailchimp.md](https://github.com/coreyhaines31/marketingskills/blob/main/to`
- `SKILL.md:327` (tools section): `| **Nitrosend** | AI-native email (sequences via prompts) | ✓ | [nitrosend.md](https://github.com/coreyhaines31/marketin`
- `SKILL.md:328` (tools section): `| **Resend** | Developer-friendly transactional | ✓ | [resend.md](https://github.com/coreyhaines31/marketingskills/blob/`
- `SKILL.md:329` (tools section): `| **SendGrid** | Transactional email at scale | - | [sendgrid.md](https://github.com/coreyhaines31/marketingskills/blob/`
- `SKILL.md:330` (tools section): `| **Kit** | Creator/newsletter focused | - | [kit.md](https://github.com/coreyhaines31/marketingskills/blob/main/tools/i`
- `SKILL.md:336` (related row: lead-magnets not installed): `- **lead-magnets**: For planning lead magnets that feed into nurture sequences`
- `SKILL.md:337` (related row: churn-prevention not installed): `- **churn-prevention**: For cancel flows, save offers, and dunning strategy (email supports this)`
- `SKILL.md:338` (related row: onboarding not installed): `- **onboarding**: For in-app onboarding (email supports this)`
- `SKILL.md:340` (related row: ab-testing not installed): `- **ab-testing**: For testing email elements`
- `SKILL.md:341` (related row: popups not installed): `- **popups**: For email capture popups`
- `SKILL.md:342` (related row: revops not installed): `- **revops**: For lifecycle stages that trigger email sequences`

### analytics

- `SKILL.md:349` (tools section): `## Tool Integrations`
- `SKILL.md:351` (tools section): `For implementation, see the [tools registry](https://github.com/coreyhaines31/marketingskills/blob/main/tools/REGISTRY.m`
- `SKILL.md:353` (tools section): `| Tool | Best For | MCP | Guide |`
- `SKILL.md:354` (tools section): `|------|----------|:---:|-------|`
- `SKILL.md:355` (tools section): `| **GA4** | Web analytics, Google ecosystem | ✓ | [ga4.md](https://github.com/coreyhaines31/marketingskills/blob/main/to`
- `SKILL.md:356` (tools section): `| **Mixpanel** | Product analytics, event tracking | - | [mixpanel.md](https://github.com/coreyhaines31/marketingskills/`
- `SKILL.md:357` (tools section): `| **Amplitude** | Product analytics, cohort analysis | - | [amplitude.md](https://github.com/coreyhaines31/marketingskil`
- `SKILL.md:358` (tools section): `| **PostHog** | Open-source analytics, session replay | - | [posthog.md](https://github.com/coreyhaines31/marketingskill`
- `SKILL.md:359` (tools section): `| **Segment** | Customer data platform, routing | - | [segment.md](https://github.com/coreyhaines31/marketingskills/blob`
- `SKILL.md:365` (related row: ab-testing not installed): `- **ab-testing**: For experiment tracking`
- `SKILL.md:366` (related row: conversion-tracking not installed): `- **conversion-tracking**: For getting conversions (including GA4 key events from forms and bookings) to ad platforms an`
- `SKILL.md:367` (related row: attribution not installed): `- **attribution**: For attribution models, multi-touch/MMM/incrementality, and reconciling conflicting numbers across to`
- `SKILL.md:370` (related row: revops not installed): `- **revops**: For pipeline metrics, CRM tracking, and revenue attribution`

### customer-research

- `SKILL.md:301` (related row: competitors not installed): `| Building a competitor comparison page | 'competitors' |`
- `SKILL.md:302` (related row: churn-prevention not installed): `| Creating a churn prevention strategy from churn research | 'churn-prevention' |`
- `SKILL.md:303` (related row: ads not installed): `| Planning paid ads informed by research | 'ads' |`
- `SKILL.md:304` (related row: cold-email not installed): `| Writing cold email using research on pain/trigger | 'cold-email' |`
- `SKILL.md:305` (related row: prospecting not installed): `| Translating customer research into an ICP for outbound | 'prospecting' |`
- `SKILL.md:307` (related row: marketing-plan not installed): `| Rolling research into a comprehensive marketing plan | 'marketing-plan' |`
- `SKILL.md:308` (related row: marketing-plan not installed): `| Sizing the market (TAM/SAM/SOM) — see the market-sizing reference | 'marketing-plan' |`
- `references/source-guides.md:336` (registry link): `See [tools/integrations/sparktoro.md](https://github.com/coreyhaines31/marketingskills/blob/main/tools/integrations/spar`

### offers

- `SKILL.md:151` (related row: launch not installed): `- **launch** — for the moment you ship the offer`
- `SKILL.md:152` (related row: paywalls not installed): `- **paywalls** — for in-app upgrade-prompt versions of an offer`
- `SKILL.md:153` (related row: sales-enablement not installed): `- **sales-enablement** — for the deck and one-pager that carry the offer into a sales conversation`
- `SKILL.md:155` (related row: marketing-psychology not installed): `- **marketing-psychology** — for the cognitive biases that make offers land or bounce`

## House rules in front of these skills

Copy produced through these skills gets `unslop-text` as the final pass (the pack is written in the
register that skill strips, em dashes included). Any customer-facing claim, statistic or
certification goes through `substantiate-outward-claims` before it ships.
