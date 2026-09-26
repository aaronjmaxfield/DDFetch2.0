/**
 * SecurePay terms that people paste from the SOPs and that do not match the
 * logs.
 *
 * -------------------------------------------------------------------------
 * WHERE THESE CAME FROM
 * -------------------------------------------------------------------------
 * All eleven pages of the engineering SecurePay SOP set (Confluence IT hub
 * 7349895367) were tested against live Datadog on 2026-09-25, one agent per
 * page. Five of them tell Support to search for a field or value that never
 * appears, and the most common way a frontline user builds a query is to copy
 * the SOP's wording into Additional Parameters. Each entry below is a term that
 * returned zero where the SOP said it would match, paired with the term that
 * does match and the count behind it. Measured on app-pci-payment-adapter,
 * env:eng-arch-pci, 15-30 day windows -- the only PCI env visible to us.
 *
 * These are warnings, never rewrites. The user's text goes into the query
 * exactly as typed; the tool only says what it expects to come back.
 */

export interface SecurePayLint {
  /** Tested against Additional Parameters. */
  pattern: RegExp;
  /** Only raise when the SecurePay scope or service is selected. */
  securePayOnly?: boolean;
  /** Suppress when this also matches -- the user already did the right thing. */
  unless?: RegExp;
  message: string;
}

export const SECUREPAY_LINTS: SecurePayLint[] = [
  {
    /*
     * The PGF-001 SOP's own Log Explorer link filters on status:error. Measured:
     * every `payrix /txns result` line is info (241 of 241), including the
     * declines; `GIACT decision` is warn (3 of 3); `GIACT_BLOCK` and the
     * callback body are debug; `overallStatus=FAILED` is info (4 of 4).
     */
    pattern: /status:\s*\(?\s*error/i,
    securePayOnly: true,
    message:
      'status:error hides most SecurePay outcomes. A card decline is logged at info ("payrix /txns result ... outcome=declined"), a GIACT/ACH block at warn, and a failed multi-merchant payment at info. Remove status:error, or search for the outcome text instead.',
  },
  {
    // REPLAY runbook Step 7. 0 of 30 days; the real counter is free text.
    pattern: /JMSXDeliveryCount/i,
    message:
      'JMSXDeliveryCount does not appear in the logs (0 in 30 days). The callback retry counter is written as "delivery attempt: N from queue: local-responses".',
  },
  {
    // CBF-001. The real token is "redeliveries: n/5" (0/5 = rejected, 5/5 = dependency down).
    pattern: /redelivery-attempts/i,
    message:
      'redelivery-attempts does not appear in the logs. The real field is "redeliveries: n/5" -- 0/5 means the far end rejected the call outright, 5/5 means it was unreachable every time.',
  },
  {
    // PGF-001 Step 1 table. The field is payrixStatus (1 approved, 2 declined; no other value seen).
    pattern: /payrixCode/i,
    message:
      'payrixCode does not appear in the logs. The field is payrixStatus: 1 is approved, 2 is declined. Search "payrixStatus=2", quoted.',
  },
  {
    // PGF-001 Step 2 and OUTAGE Step 2. @merchant:* is zero on every service.
    pattern: /@merchant\b/i,
    message:
      'There is no @merchant field in Datadog -- the merchant ID only appears inside the message text. Put the t1_mer_ ID in the SecurePay Merchant ID box instead.',
  },
  {
    // DUPE Collect item 3. @serviceProviderCode:* = 0; @SERV_PROV_CODE:* = 13,884 in 15 days.
    pattern: /serviceProviderCode/,
    message:
      'serviceProviderCode is not a log field (0 lines). The agency is @SERV_PROV_CODE, and the Agency box above already filters on it.',
  },
  {
    // PGF-001 Step 2. No service by that name ships logs we can see.
    pattern: /secure-pay-hub-service/i,
    message:
      'secure-pay-hub-service has no logs in Datadog that we can see. SecurePay adapter activity is in app-pci-payment-adapter, which the SecurePay option already searches.',
  },
  {
    // PGF-001 Step 1. With a space it is not a token; the real tokens are below.
    pattern: /GIACT\s+BLOCK/i,
    message:
      '"GIACT BLOCK" with a space does not appear in the logs. Search "verdict=BLOCK" (the warn-level decision line) or GIACT_BLOCK (debug level, inside the callback body).',
  },
  {
    /*
     * Three separate SOP tests hit this. The bare phrase also matches
     * `Failed delivery ... Exhausted after delivery attempt: 1 ... No payment
     * intent found` on retrieve-payment-intent-route -- an expired payment
     * link, nothing to do with callbacks (17 in 30 days).
     */
    pattern: /delivery attempt/i,
    unless: /local-responses|response-queue-listener/i,
    message:
      '"delivery attempt" also matches an unrelated error: "Exhausted after delivery attempt: 1 ... No payment intent found", which means an expired payment link, not a callback retry. For callback retries add "from queue: local-responses" to the search.',
  },
];

/**
 * Warnings for Additional Parameters. `securePay` is whether the SecurePay
 * option or service is part of this search.
 */
export function lintSecurePayTerms(additionalParams: string, securePay: boolean): string[] {
  const text = additionalParams ?? '';
  if (!text.trim()) return [];
  return SECUREPAY_LINTS.filter(
    (l) => (!l.securePayOnly || securePay) && l.pattern.test(text) && !(l.unless && l.unless.test(text))
  ).map((l) => l.message);
}
