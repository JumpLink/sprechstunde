# 1. Multi-tenant platform with OIDC login

Status: accepted (2026-10-20)

## Context

sprechstunde started as one assistant for one venue, configured through JSON files and a settings
UI that only listens on loopback. The goal is now a platform that several business customers use:
each with their own login, venues, characters and phone numbers, reachable over the internet.

## Decision

**Tenants.** A tenant is one business customer. It owns users, venues, characters, phone numbers
and a usage account. Every stored row carries a tenant id, and all access goes through one data
layer; tests prove that tenant A can neither read nor write tenant B's data.

**Venue and character.** A venue (today: "profile") holds what the assistant knows: greeting,
facts, instructions, transfer. A character holds who speaks: name, gender, voice, fallback voice
and an optional tone. A venue picks its character. The word "preset" leaves the UI.

**Call routing.** The dialled number selects the venue: number → venue → character → voice,
resolved per call. LiveKit SIP exposes the dialled number as the participant attribute
`sip.trunkPhoneNumber`. An unknown number gets the neutral fallback announcement, never another
tenant's venue.

**Storage.** SQLite replaces the JSON files once there is more than one tenant. The profile
history moves with it. Postgres stays an option behind the same data layer.

**Login.** sprechstunde never stores passwords. It authenticates users through OIDC; the first
identity provider is Authelia (two-factor, passkeys, brute-force protection, maintained by people
whose job that is). Which tenant a user belongs to and which role they have lives in
sprechstunde's own database, not in the identity provider. A single-person install keeps working
without login, bound to loopback.

Roles: *platform admin* (tenants, numbers, which voices and models are allowed, usage),
*tenant admin* (venues, characters, inviting users), *member* (edit venue knowledge only).

**Provider keys and usage.** All calls run on the platform operator's provider keys. Usage is
metered per tenant: call minutes, TTS characters, LLM tokens, voice previews (with a limit).
Customers choose only from voices and models the platform admin has allowed. Customer-supplied
keys may come later.

## Consequences

- Authelia has no self-registration or invitation links; users are created by the operator. That
  is fine for a handful of customers. Beyond that, switch to a provider with invitations
  (Zitadel, Authentik, Keycloak); since the app only speaks OIDC, sprechstunde does not change.
- The operator becomes a data processor for every customer: a data processing agreement per
  customer and a list of sub-processors (the TTS, STT and LLM vendors) are needed. Not legally
  reviewed.
- Transcripts stay off in production; metrics and history are separated per tenant. The AI
  disclosure in the greeting remains mandatory for every venue (EU AI Act Art. 50).
- Whether the SIP provider allows extra numbers on one trunk or needs one trunk per customer is
  not verified.

## Order

1. Character editor with voice casting, with a tenant id in the data model from the start.
2. SQLite and number-to-venue routing. Started with the knowledge sources (`src/admin/knowledge-*`): the admin
   writes SQLite and publishes each venue's live text as a file next to the profile; the agent reads
   only that file, never the database. Number-to-venue routing is still open.
3. OIDC login and roles; the settings UI becomes the customer portal plus a platform admin area.
4. Usage metering and limits per tenant, billing after that.
