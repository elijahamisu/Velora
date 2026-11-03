# Afrstar payment gateway

Altivex can collect deposits and pay withdrawals through the Afrstar Nigeria Payment API v2
(`https://ngn.afrstar.com`).

**Deposits** follow `site_settings.deposit_mode`, switched at the top of the admin **Gateway** page
(`admin/gateway.html#depositMode`, with a confirm dialog; Settings only links there):

- **Manual bank transfer** (`manual`): clients see the bank details, admin approves/rejects each deposit.
- **Automatic via Afrstar** (`gateway`): Afrstar hosted checkout, credited by callback.

`site_settings.payment_mode` is a legacy alias kept equal to `deposit_mode` by the `sync_deposit_mode`
trigger (writing either one updates both; if both change, `deposit_mode` wins).

**Withdrawals are always gateway-based**, whatever the deposit mode: clients must pick their bank from the
Afrstar list (`bank_code` required by `user_request_withdrawal`), and every request waits for an admin, who
chooses one of three actions on a pending row (admin/withdrawals.html and the user details page):

| Button | API action | Result |
| --- | --- | --- |
| Send to gateway | `send_gateway` | pending → processing, Afrstar payout of amount − fee; callback finalises (approved / failed + refund) |
| Mark as paid | `mark_paid` (`complete` still accepted) | admin paid it outside the gateway: pending → approved, no payout call, user notified |
| Reject | `reject` | pending → rejected, full amount refunded to the wallet, ledger row + notification |

## Setup

1. Vercel env vars (server only, never `VITE_`): `AFRSTAR_MERCHANT_SN`, `AFRSTAR_MERCHANT_AK`, `AFRSTAR_MERCHANT_SK`.
   If any is missing, every gateway endpoint answers with a clear "not configured" error and the UI shows it.
2. In the Afrstar merchant portal set:
   - Collection callback URL: `https://altivex-invest.vercel.app/api/afrstar/payin-callback`
   - Payout callback URL: `https://altivex-invest.vercel.app/api/afrstar/payout-callback`
3. If Afrstar restricts by source IP, the admin Gateway page shows the gateway's error and the IP the
   request came from. Vercel functions do not have a fixed egress IP; a static IP needs Vercel Secure Compute or a proxy.
4. Switch the deposit mode on the Gateway page to Automatic via Afrstar.

## Endpoints

| Path | Who | What |
| --- | --- | --- |
| `POST /api/deposits/create` | signed-in user | creates a payin order (`ALXD-…`), stores a `deposits` row (`method='gateway'`, pending), returns `pay_url` |
| `POST /api/afrstar/payin-callback` | Afrstar | verifies `md5(ak+platform_osn+status+STORED order amount+sk)`, credits once |
| `POST /api/afrstar/payout-callback` | Afrstar | verifies `md5(ak+platform_osn+status+amount+sk)`, checks amount = stored payout amount |
| `POST /api/admin/withdrawals` `{action:'send_gateway', id, bank_code?}` | admin | creates a payout for the net amount (amount − fee) |
| `POST /api/admin/withdrawals` `{action:'mark_paid' \| 'reject', id}` | admin | `admin_mark_withdrawal_paid` / `admin_reject_withdrawal` (service role only; lock the withdrawal and wallet rows) |
| `GET /api/admin/gateway?action=balance` | admin | live balance |
| `POST /api/admin/gateway` `{action:'payout', …}` / `{action:'topup', …}` | admin | admin withdrawal of gateway funds / gateway top-up |

Callbacks answer HTTP 200 with the exact body `success` (no newline) only after the result is stored.
Anything unverifiable (bad signature, unknown order, amount mismatch, missing config) gets a non-200,
non-`success` reply, so nothing is applied and the gateway retries.

## Order numbers

`<PREFIX>-<UTC yyyymmddHHMMSS>-<8 hex>`; callbacks route on the prefix:

- `ALXD` user deposit → `deposits`
- `ALXW` user withdrawal → `withdrawals`
- `ALXAT` admin top-up → `gateway_admin_transactions` (kind `topup`), never touches a user wallet
- `ALXAP` admin payout → `gateway_admin_transactions` (kind `payout`)

## Money rules

- **Deposit credit amount.** Afrstar's callback `amount_paid` can differ from the order amount. We credit
  `min(order amount, amount_paid)`: an overpayment credits the order amount, a partial payment credits what
  was actually paid. If `amount_paid` is absent we credit the order amount (status 1 with a valid signature).
  The referral commission (Settings %) is paid on the credited amount, exactly like `admin_approve_deposit`.
  Only `status = 1` credits. Any other status marks a pending deposit `failed` (a later status 1 still credits once).
- **User withdrawals (always gateway-based).** The balance is deducted when the client requests (unchanged).
  Admin taps *Send to gateway*: the row is claimed `pending → processing`, then a payout of `amount − charge`
  is created. Callback `1` → `approved` (shown as Completed) + notification; `9` → `failed`, the full
  requested amount is refunded to the wallet + notification. If Afrstar refuses the request outright the row
  goes back to `pending` with the gateway's message. If the request times out the row stays `processing`
  (the payout may exist); the admin can *Reject & refund* it only after checking the Afrstar portal.
  Reject and Mark as paid never read-then-write the wallet in the API: each is one Postgres function that
  locks the withdrawal row (and for a refund the wallet row) and is a no-op (`conflict`) on a second click.
- **Admin withdrawals of gateway funds.** The amount entered is what the bank account receives. An 11% fee
  is added: total = amount × 1.11, which must be ≤ the live balance (checked server-side right before
  sending). The payout sent to Afrstar is the entered amount.
- All money changes from callbacks run inside Postgres functions (`gateway_apply_payin`,
  `gateway_apply_payout`, `gateway_apply_admin`) that lock the row and check its state, so retries and
  manual re-pushes are no-ops. They are executable by the service role only.

## Bank codes

`src/ng-banks.js` holds the 142 Nigeria payout bank codes from the Afrstar doc. The withdrawal form uses it
as a dropdown (no free-text "Other bank" any more) and stores `bank_code`. Older free-text bank names are mapped with `guessBankCode()` when the
admin sends a payout; the admin confirms or picks the bank in the send dialog.

## Tests

- `npm test` runs `tests/afrstar.test.mjs` (signatures with known vectors, request bodies, error
  classification, callback handling with a stubbed Supabase, bank mapping). No network.
- `npm test` also runs `tests/withdrawal-actions.test.mjs` (send to gateway, mark as paid, reject, admin-only, deposit_mode routing of `/api/deposits/create`).
- `tests/withdrawal-actions.sql` (rolled back) checks the deposit_mode/payment_mode sync, bank_code requirement, mark-as-paid and reject-refund functions, grants and row locks.
- `tests/gateway-functions.sql` exercises the Postgres functions and triggers inside a transaction that is
  rolled back (credit once, partial/over payment, refunds, admin rows, RLS/trigger protections).
