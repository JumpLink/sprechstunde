# 2. Knowledge feed

Status: accepted (2026-11-10)

## Context

A venue's opening hours, menus and answers to common questions live in its own system: a website
CMS, a booking tool, a spreadsheet. sprechstunde reads that knowledge from web pages, sitemaps,
PDFs and pictures. Pages are written for guests, not for an assistant: a menu is a picture, an
expired card stays reachable, a season's hours sit between the lines of a paragraph. Each source
kind needs its own cleanup, and none of them tells the assistant what is valid *today*.

## Decision

**One document, defined here.** A venue publishes one JSON document. sprechstunde defines its
format (see [docs/feed/README.md](../feed/README.md)); a venue's system adapts to it, not the other
way round. The vocabulary is schema.org (`openingHoursSpecification`, `hasMenu`, `offers`, …) so
a system that already emits JSON-LD is close, and a small extension (`faq`) covers what schema.org
has no property for.

**A new source kind `feed`.** It fetches the document, validates it and writes it as Markdown, one
section per part: `about`, `hours`, one per valid menu, `faq`. A section is addressed
`<feed address>#<part>`, so history and review work as for every other source.

**Validity is applied by sprechstunde, not by the venue.** Every refresh reads the day in the feed's
time zone. A menu outside its window is not written; hours that are over are dropped; seasons that
lie ahead stay, with their dates written out. A part that drops out of the text is marked gone, and
unlike a sitemap page, a gone feed part leaves the published text. Otherwise an expired card would
stay live.

**The format is strict.** A feed that fails validation is reported on the source with the path of
the fault, and the last published text stays. A menu needs a description written for the
assistant. This is deliberate: a format that accepts anything delivers nothing the assistant can
rely on.

**Pull first.** sprechstunde fetches the feed (through the same safe fetcher as every web source,
every six hours by default). The feed carries public information only, so v1 has no token.

## Deliberately missing

- **Access tokens.** Needed once a feed carries something not public.
- **Conditional requests (`ETag`).** The document is small; add it when a feed is not.
- **Push and webhooks.** A venue that changes a menu cannot yet trigger a refresh; the next
  scheduled read picks it up. A push API is the follow-up.
- **A JSON Schema file.** The TypeScript validator in `src/admin/feed.ts` is the one definition;
  a second one would drift.

## Consequences

- A venue gets answers that follow its own calendar without anyone editing sprechstunde.
- Text, image and PDF sources stay for what has no feed.
- The format is a public contract: a change that breaks a valid feed needs a new `version`.
