# Drip

Drip covers lessons that open some days after a member's access to their
course starts. Its language spans the delay on a lesson, the moment access
started, and the moment the lesson opens.

## Language

**Drip days**:
The delay on one lesson, from an internal tag named `#drip-<n>`. Several drip
tags take the largest; `#drip-0` is no delay.
_Avoid_: Drip slug, schedule

**Dripped lesson**:
A `visibility: 'tiers'` post with drip days. Other visibilities ignore drip
tags.
_Avoid_: Locked post (a post can be locked by tiers alone)

**Access start**:
When a member's current holding of a tier began: the latest `added` product
event for the tier or the start of an active Stripe subscription on it,
whichever is earlier, else signup. Per lesson, the earliest access start over
the lesson's tiers the member holds.
_Avoid_: Purchase date, comp date

**Unlock time**:
The start of the access-start day in the site timezone plus the drip days, as
calendar days. Exposed as `unlock_at` (ISO 8601 UTC) only while it is in the
future.
_Avoid_: Release date

**Mode**:
`enforce` withholds a dripped lesson until its unlock time; `advise` shows the
unlock time without locking; `off` disables drip.
_Avoid_: Drip enabled flag

**Shim**:
A stand-in member without `id` or `uuid` (gift links, previews). Drip leaves a
shim's access unchanged; a preview shows the unlock time.
_Avoid_: Fake member

**Drip index**:
The in-memory map from post id to drip days, reloaded on post and tag changes.
_Avoid_: Drip cache
