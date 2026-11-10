# Knowledge feed

A venue publishes one JSON document; sprechstunde reads it as a source of kind **Feed** and keeps
the assistant's knowledge in step with it. Why this exists:
[ADR 2](../adr/0002-knowledge-feed.md). A complete example: [example.json](example.json).

Add it in the admin under *Sources → Feed*, or through the API with
`{"kind": "feed", "url": "https://…/feed.json"}`. It is read every six hours by default. The
address must answer with `application/json` or `application/ld+json`.

The feed contains **public information only**. There is no token in version 1.

## Document

| Field                              | Required | Meaning                                                                |
| ---------------------------------- | -------- | ---------------------------------------------------------------------- |
| `version`                          | yes      | Must be `1`.                                                           |
| `timeZone`                         | yes      | IANA zone such as `Europe/Berlin`. "Today" is read in this zone.       |
| `inLanguage`                       | no       | Language of the texts, default `en`. Decides how dates and prices read. `en` and `de` have their own headings; any other language uses English headings. |
| `name`, `description`, `url`       | no       | About the venue.                                                       |
| `address`                          | no       | schema.org `PostalAddress`: `streetAddress`, `postalCode`, `addressLocality`. |
| `openingHoursSpecification[]`      | no       | Regular hours.                                                         |
| `specialOpeningHoursSpecification[]` | no     | Exceptions that apply instead of the regular hours.                    |
| `hasMenu[]`                        | no       | Menus.                                                                 |
| `faq[]`                            | no       | Questions guests ask.                                                  |

### Opening hours

`name`, `description`, `dayOfWeek` (one day or a list, `Monday` or `https://schema.org/Monday`),
`opens`, `closes` (`HH:MM`; `closes` may be `24:00`), `validFrom`, `validThrough` (`YYYY-MM-DD`,
both included).

- Without `dayOfWeek`, a regular entry means every day.
- `opens` and `closes` both `00:00` means closed.
- An **exception** needs `validFrom` and `validThrough`; with no `dayOfWeek` it applies to every
  day in that period.
- An entry whose `validThrough` has passed is dropped. One that starts later stays, with its dates.

### Menus

`name`, **`description`** (required: a short text for the assistant: what this card is, when it
applies, what to say about it), `validFrom`, `validThrough`, `hasMenuSection[]`.

A section has `name`, `description` and `hasMenuItem[]`. An item has `name`, `description` and
`offers: {"price": 18.5, "priceCurrency": "EUR"}`.

A menu outside its window is **not written at all**, so the assistant cannot offer an old card.

### Questions

```json
{ "name": "Are dogs welcome?", "acceptedAnswer": { "text": "Yes, on a lead." } }
```

`"assistantMaySay": false` keeps an entry in your feed but hides it from the assistant. `faq` is not
a schema.org property of a restaurant; it is the one extension.

## What sprechstunde makes of it

One section per part, so each is reviewed, versioned and editable like any other source:

| Part          | Address         |
| ------------- | --------------- |
| About         | `<feed>#about`  |
| Opening hours | `<feed>#hours`  |
| Each menu     | `<feed>#menu-N` where N is its position in `hasMenu`, starting at 1 |
| Questions     | `<feed>#faq`    |

The menu number follows the position in the feed, so a card keeps its address when an earlier one
expires. A part that is no longer written is marked gone and leaves the text the assistant reads.
A feed that fails validation changes nothing: the error, with the path of the fault, shows on the
source, and the last published text stays.

## Not in version 1

Tokens for non-public feeds, `ETag` handling, push and webhooks. Until push exists, a change shows
up with the next scheduled read, or when someone presses *Refresh* on the source.
