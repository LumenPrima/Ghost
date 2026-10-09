# Purchases

Purchases covers one-time payment for lifetime access to one membership tier
(a course, on the Salvare site). Its language spans the purchase, the access it
grants, and the refund that takes it away.

## Language

**Purchase**:
A one-time payment for one tier, recorded in `members_purchases`. A purchase is
`paid` or `refunded`; it never renews.
_Avoid_: Order, one-time subscription

**Purchaser**:
The member who receives the access a purchase grants. A guest checkout grants
access to the member who owns the checkout email, creating that member if
needed.
_Avoid_: Buyer, customer

**Purchase-sourced link**:
A `members_products` link backed by a paid, unexpired purchase of that tier.
Comp, gift and subscription flows leave such links in place.
_Avoid_: Purchased product, comp

**Lifetime access**:
Access with no expiry: a purchase with `expires_at` null, and its link with
`expiry_at` null.
_Avoid_: Permanent comp

**Full refund**:
A refund of the whole charge (`charge.refunded` is true). Only a full refund
revokes a purchase's access; a partial refund leaves it in place.
_Avoid_: Cancellation
