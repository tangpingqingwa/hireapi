# HireAPI

Build contract: [SPEC.md](./SPEC.md).
How we work: [CONTRIBUTING.md](./CONTRIBUTING.md). `main` stays buildable and testable.
How we build: [BUILD.md](./BUILD.md) — stack, modules, tests, PR sequence.

Public job posts from Indeed, LinkedIn job pages, and modern ATS boards (Greenhouse, Ashby, Lever) in one schema.

There is no honest self-serve “jobs API” for builders who are not a job board partner.

## Why this, and why overseas

US hiring tools, salary agents, “what is this company actually posting,” and weekly job digests all scrape HTML today. Indeed Publisher and LinkedIn Jobs are partner programs. Greenhouse/Ashby boards are public HTML with a different shape per vendor.

Queries: `indeed api`, `linkedin jobs api`, `greenhouse api jobs`, `job listings api 2026`.

## Exact demand

- Who: talent agents, indie job boards, recruiting newsletters, DailyBrief
- Input: job URL, company board URL, or keyword + location
- Output: title, company, location, remote flag, salary if present, description Markdown, source, apply URL
- Acceptance: one job URL → one record; board list → paginated records; ATS vendor hidden behind the schema

## Exact connector

| Endpoint | Job | Credits |
|---|---|---|
| `/v1/jobs/by-url` | One posting | 1 |
| `/v1/search` | Keyword + geo + source | 1 / hit |
| `/v1/boards/by-url` | Full public ATS board | 1 / job returned |
| `/v1/companies/{id}/jobs` | Normalized company feed | 1 / page |

MCP: `get_job`, `search_jobs`, `list_board`.

Ship Greenhouse + Ashby + Lever first — they are easier and legally cleaner than LinkedIn. Add Indeed when the contract is stable. Do not put LinkedIn on the homepage until it survives a week of CI.

## Exact combination

- SEO: `Does Indeed still give API keys?` / `How to parse a Greenhouse board`
- $19 / mo / 3,000; free 100
- DailyBrief: “these ten companies’ new roles”
- Agent: “remote TypeScript jobs posted this week, salary if listed”
- We do not become a job board. Apply links go to the source

## Cost control

- Individual jobs cache until `closed` or 24h
- Search TTL in minutes
- Descriptions as Markdown, no HTML junk
- LinkedIn (if ever) isolated so a ban does not take ATS down
- Failures 0 credits

## Business model

Credits. ATS-board ingestion can be the wedge (clearer ToS, happier cache). Aggregator search is the upsell.

Success: 10 customers pulling boards on a cron; our own hiring watch uses only HireAPI; MRR covers proxies with room.

## Will not do

- No apply-on-behalf, no outreach sequencer
- No resume parsing in v1
- No “easy apply” automation
- No implied LinkedIn partnership

## First two weeks

1. `by-url` + `boards/by-url` for Greenhouse and Ashby
2. Markdown description cleaner
3. 20 real company boards as fixtures
4. MCP `list_board`

## Dogfood

A personal “companies I would join” list refreshes daily through HireAPI. If we still open Lever in a browser to see openings, it is not shipped.

## Risk

LinkedIn is the lawsuit magnet — keep it off the marketing site until the rest is a business. Customer terms: read-only, no scraping credentials, no spam. When a board 404s, mark the job closed, do not keep serving a ghost.
