# Purchases

Salvare fork (`fork(salvare)`): one-time purchases of a tier. A purchase grants
lifetime access to the tier's content without a subscription.

This module's interface is capability-oriented. Callers do not receive Knex
rows, transactions, or Stripe objects.

## Interface

- `startCheckout(input)` finds the tier by `tierId` or `tierSlug`, validates
  it (paid, active, with a `one_time_price`), resolves the member from the trimmed email it will sign,
  asks an existing but unauthenticated member to sign in
  (`PURCHASE_SIGNIN_REQUIRED`, plus a sign-in email, whatever they own),
  refuses a tier the signed-in member already holds through an active purchase
  (`PURCHASE_ALREADY_OWNED`; a comp, gift or subscription does not block a purchase),
  and creates a Stripe Checkout session in payment mode with the tier's stored
  one-time Stripe price. The server owns the price; the client never sends an
  amount. Only an email with no member gets a pre-checkout signup magic link as
  the success URL, so the buyer comes back signed in.
- `fulfil(input)` takes a parsed, Stripe-free completed checkout. Inside one
  transaction it finds or creates the member, grants the tier, links a trusted
  Stripe customer and inserts the purchase row. It then sends the buyer's access
  email and the staff notification. It is idempotent: the unique checkout
  session id is the guard, and emails go out only after a real insert. A
  payment that was refunded before fulfilment is recorded as `refunded` and
  grants nothing. A redelivery that shows a full refund revokes a row recorded
  as `paid`. The webhook re-reads the PaymentIntent after a fulfilment commits
  and revokes the purchase if it was refunded meanwhile, because that refund's
  own `charge.refunded` found no row. A PaymentIntent without a `charges` list
  (a newer Stripe API version) fails the webhook rather than reading as "not
  refunded".
- `refund(input)` handles `charge.refunded`. Only a full refund revokes access;
  partial refunds are logged and ignored.

`purchase-links.ts` holds the single definition of an active purchase (`paid`
and not expired). The member repository uses it, through an injected
`purchaseLinks` dependency, to leave purchase-sourced `members_products` links
alone when it edits a member's tiers.

## Rules worth knowing

- Checkout accepts `tierId`, `tierSlug` or both (post HTML cards only know the
  slug). `tierId` wins strictly: when it is present it is used even if it is
  invalid (400 `This tier does not exist.`), and the slug is neither validated
  nor tried as a fallback, so a stale id in a template shows up as an error.
  An unknown slug gives the same 400.
- The stored `amount` is the Checkout session's `amount_total`, so it includes
  tax when Stripe automatic tax is on.
- Metadata keys `ghost_purchase_tier_id` and `ghost_purchase_member_uuid` are
  server-only. The router strips them from client metadata, and
  `startCheckout` drops any `ghost_purchase_*` key as well.
- An existing member must sign in before checkout. If a member with the
  checkout email appears between checkout and the webhook, the purchase is
  granted to that member, but the guest's Stripe customer is linked only to a
  new member or to the member who authenticated.
- A refund of a tier that is also a gift member's gift tier keeps the link for
  the gift; the gift lifecycle removes it later.
- A second purchase of a tier the member already owns is still recorded; the
  staff email flags it as a possible duplicate.
- The one-time Stripe price is resolved lazily at checkout, serialised per tier
  within the process.

The Knex repository, the Stripe checkout adapter, the magic-link wrapper and
the email service are internal adapters.
