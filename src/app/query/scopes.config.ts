/**
 * Scoped search: the progressive-disclosure replacement for the flat
 * "Additional Services" checkbox block.
 *
 * -------------------------------------------------------------------------
 * WHY THIS SHAPE
 * -------------------------------------------------------------------------
 * The flat block cost ~150px of vertical space permanently -- a section label,
 * two group labels and five checkboxes -- whether or not you wanted any of it.
 * Meanwhile the thing that actually makes a search useful, a record or
 * transaction identifier, had nowhere to go except the free-text
 * "Additional Parameters" box.
 *
 * So: one dropdown for the area (Payment / Documents / Construct), a second for
 * the specific provider or service, and only then the fields that are worth
 * asking for in that context. Collapsed it is SMALLER than the block it
 * replaces, which is what keeps the no-scrollbar goal reachable; expanded it is
 * only bigger when the user has deliberately asked for more.
 *
 * The fast path is untouched. Civic Platform, Citizen Access and Construct API
 * are still checkboxes at the top, so "just give me biz and ACA" is zero extra
 * clicks.
 *
 * -------------------------------------------------------------------------
 * EVERY CLAUSE HERE WAS MEASURED, NOT GUESSED
 * -------------------------------------------------------------------------
 * The fields exist because live testing showed they are the identifiers people
 * actually hold, and the clause shapes are the ones that were confirmed to
 * return the right lines. See QUERY_AUDIT.md. In particular:
 *
 *   - The record number shown in the UI does NOT appear in any log. Three test
 *     payments confirmed it: 26COOL-0000022, 26COOL-0000016 and 26AMAX-0000003
 *     all return zero everywhere. The logs carry the 5-5-5 CAP ID instead, and
 *     it is not derivable from the record number -- 26AMAX-0000003 was logged as
 *     26ABC-00000-00013. Hence `capId`, its hint, and `looksLikeAltId`.
 *   - @TRANSACTION_ID casing flips with platform: AA is
 *     `urn:CRC:transaction-id:aa:CRC-6422`, ACA is
 *     `urn:crc:transaction-id:aca:crc-6432`. Facet values are case sensitive,
 *     so both casings are emitted.
 *   - Only ~50% of payment-adapter lines carry @PROVIDER, so the provider
 *     filter must be `(@PROVIDER:x OR -@PROVIDER:*)` or it guts the trace.
 */

import { EnvironmentDef } from './environments.config';

export interface ScopeFieldContext {
  agencyUpper: string;
  agencyLower: string;
  env: EnvironmentDef;
}

export interface ScopeField {
  /** DOM id, and the key under which the value is carried on QueryInput. */
  id: string;
  label: string;
  placeholder?: string;
  /** Shown under the input. Use it to name the trap, not to restate the label. */
  hint?: string;
  /** Returns the Datadog clause for a non-empty value, or '' to contribute nothing. */
  clause: (value: string, ctx: ScopeFieldContext) => string;
  /** Returns a warning when the value looks wrong but is still usable. */
  warn?: (value: string) => string | undefined;
  /**
   * Extra biz-tier markers to add, but ONLY while this field has a value.
   *
   * Some evidence is worth millions of lines in general and indispensable once
   * the user has narrowed to a single identifier. The Construct trace ID is the
   * case that forced this: the biz tier records what the API returned on lines
   * reading `... TraceId is: {id}. Response code is 200`, and there are
   * 21,850,112 of them in 24 hours. Adding that as a plain category marker would
   * bury every Construct search; adding it only when a trace ID is present costs
   * nothing, because the trace-ID clause then narrows it to that one request.
   */
  bizMarkers?: string[];
  /**
   * Routine-chatter phrases to stop excluding while this field has a value.
   * Same reasoning as `bizMarkers` above, for the other gate.
   */
  chatterExceptions?: string[];
}

export interface ScopeOption {
  id: string;
  label: string;
  /**
   * The `ADDITIONAL_SERVICES` entry this option maps to, so the existing
   * service-branch builder is reused rather than reimplemented.
   */
  serviceUi?: string;
  /** Emitted as `(@PROVIDER:<urn> OR -@PROVIDER:*)` -- see the note above. */
  providerUrn?: string;
  fields?: ScopeField[];
}

export interface ScopeCategory {
  id: string;
  label: string;
  /** Shown for every option in the category. */
  fields?: ScopeField[];
  options: ScopeOption[];
  /**
   * Terms that identify biz-tier content belonging to this category.
   *
   * This is the single highest-leverage clause in the tool. The biz branch is
   * otherwise unbounded -- it matches every biz log for the agency in the
   * window, which for a large production tenant is millions of lines. Measured
   * on the busiest Forte agency in US PROD over 24 hours:
   *
   *   biz tier, unscoped        2,138,287 lines   218,581 errors
   *   biz tier, payment-scoped     74,696 lines        74 errors
   *
   * 96.5% of the volume gone, and the signal improves rather than degrades: of
   * those 218,581 errors only 74 relate to payments at all, so an unscoped
   * payment investigation is 99.97% distraction. Every real payment failure in
   * the window survived -- CreditCardPaymentException, completePayment,
   * Payment Required, CE_INVOICE_UNPAID.
   *
   * Markers are WILDCARD form on purpose. For positive matching, `*token*` is
   * the dependable shape: quoted phrases silently under-match on these logs and
   * fail outright on some camelCase tokens (`*getCapTypeByPK*` matches 23,426
   * lines; `"getCapTypeByPK"` matches nothing).
   *
   * Every marker below was measured against that agency rather than guessed.
   */
  bizMarkers?: string[];
  /**
   * Routine-chatter phrases NOT to exclude when this category is selected.
   *
   * Some chatter is genuinely noise in general and primary evidence in one
   * specific investigation. Rather than choose globally -- suppress it always
   * and lose the evidence, or drop it always and re-admit millions of lines --
   * the category that needs it says so.
   *
   * Entries must match the `phrase` in `ROUTINE_CHATTER` exactly, quotes
   * included. A typo silently does nothing, so there is a test asserting every
   * exception here corresponds to a real pattern.
   */
  chatterExceptions?: string[];
}

// ---------------------------------------------------------------------------
// Reusable fields
// ---------------------------------------------------------------------------

/** `26COOL-0000016` shape: two digits, letters, dash, seven digits. */
const ALT_ID = /^\d{2}[A-Za-z]{2,}-\d{6,}$/;

const capId: ScopeField = {
  id: 'capId',
  label: 'CAP ID',
  placeholder: '26ABC-00000-00014',
  hint: 'The 5-5-5 CAP ID, not the record number you see on screen -- the record number does not appear in any log.',
  clause: (v) => `*${v.trim()}*`,
  warn: (v) =>
    ALT_ID.test(v.trim())
      ? `"${v.trim()}" looks like a record number (Alt ID) rather than a CAP ID. Record numbers do not appear in the logs and cannot be derived from them -- open the record and use the CAP ID, which looks like 26ABC-00000-00014.`
      : undefined,
};

const transactionId: ScopeField = {
  id: 'transactionId',
  label: 'Transaction ID',
  placeholder: 'CRC-6422 or the full urn',
  hint: 'Accepts the short form or the full urn. Both casings are searched, because AA logs it uppercase and ACA lowercase.',
  clause: (v) => {
    const t = v.trim();
    // Both casings: the facet is case sensitive and the platform decides which
    // one is written. A free-text match on the tail also catches the lines that
    // carry the id in the body but NOT on the @TRANSACTION_ID facet -- which
    // includes the purpose/amount line, the one that says what was paid.
    return `(@TRANSACTION_ID:*${t.toUpperCase()}* OR @TRANSACTION_ID:*${t.toLowerCase()}* OR *${t}*)`;
  },
};

const providerTxId: ScopeField = {
  id: 'providerTxId',
  label: 'Provider transaction ID',
  placeholder: 'trn_f373ed08... or 1B546634LK055843D',
  hint: "The gateway's own reference, from the payment receipt or the provider portal.",
  clause: (v) => `*${v.trim()}*`,
};

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const SCOPES: ScopeCategory[] = [
  {
    id: 'payment',
    label: 'Payment',
    fields: [capId, transactionId, providerTxId],
    // Measured 24h volumes on the busiest Forte agency: transaction-id 61,081,
    // forte 7,893, payment 4,525, invoice 1,193, receipt 463, F4PAYMENT 34.
    //
    // ------------------------------------------------------------------------
    // THE SECOND FIVE WERE ADDED AFTER A SIGNAL-LOSS AUDIT (2026-08-28)
    // ------------------------------------------------------------------------
    // The original seven were measured on ONE agency, in ONE environment, on
    // biz-tier lines. They do not hold on the ACA tier, and the gap hid the
    // single most common "I paid and got no receipt" error in production.
    //
    // `AccelaAdapter webhook not recieved for transactionId :{guid}` carries NO
    // agency, NO logger and NO payment token in production, so none of the
    // original markers can see it. Measured over 7 days:
    //
    //   HOLLYWOOD   53 errors -> 0 survived the original markers
    //   LEECO      262 errors -> 0 survived
    //   SANTAANA     5 errors -> 0 survived
    //
    // All three recover fully with `*AccelaAdapter*`. The one case that DID
    // survive during testing only did so because that environment's ACA log
    // happened to keep the log4net prefix `Accela.ACA.Web.Payment...`, so
    // `*payment*` matched the LOGGER NAME rather than the message. 0 of 315
    // sampled production lines carry that prefix. Do not rely on it.
    //
    // Recovery measured estate-wide over 24h, "exists" vs "visible to the
    // original seven":
    //
    //   *log postback data begin*   2,890 exist,     97 visible   (96.6% hidden)
    //   *CONV_FEE*                  2,662 exist,      8 visible   (99.7% hidden)
    //   *proTransID*                5,176 exist,  4,211 visible
    //   *gatewayTransactionId*     26,291 exist, 26,204 visible
    //
    // `*CONV_FEE*` is NOT redundant with `*convFee*`. They are provably
    // disjoint -- measured intersection exactly 0 -- because underscore is not
    // a Datadog token separator, so `convFee` never matches `CONV_FEE`. This is
    // not a casing issue: `*CONVFEE*` matches the same set as `*convFee*`, and
    // `*conv_fee*` the same set as `*CONV_FEE*`. Free text stays
    // case-insensitive; it is the underscore that splits them.
    //
    // Cost: zero on the biz tier. On the ACA tier, LEECO over 24h goes 8,621 ->
    // 10,793 (+25.2%), which buys back 45 webhook errors that were invisible.
    bizMarkers: [
      '*transaction-id*',
      '*payment*',
      '*invoice*',
      '*receipt*',
      '*forte*',
      '*F4PAYMENT*',
      '*convFee*',
      '*CONV_FEE*',
      '*AccelaAdapter*',
      '*proTransID*',
      '*gatewayTransactionId*',
      '*log postback data begin*',
      // The sequence-allocation lines are gated TWICE -- by the
      // `lSeqRemaining` chatter pattern and by these markers. Dropping the
      // chatter exception alone recovered nothing, because no marker contains
      // "etransaction": `*transaction-id*` is not a substring of
      // `etransaction_seq2`. Measured on LEECO PROD over 24h, this marker costs
      // 89 lines, adds zero errors, and takes `*ETRANSACTION_SEQ2*` from 0 to
      // 38. `*F4PAYMENT_SEQ*` needed nothing: `*F4PAYMENT*` already substring-
      // matches it inside the token.
      '*ETRANSACTION*',
    ],
    /*
     * `lSeqRemaining` passes the routine-chatter admission test -- it contains
     * zero errors and zero warns -- and still destroys primary evidence, because
     * the sequence-allocation lines are INFO. Excluding it takes
     * `*ETRANSACTION_SEQ2*` from 21,095 to 2 and `*F4PAYMENT_SEQ*` from 22,331
     * to 2. Those lines are the proof-of-initiation fingerprint in five closed
     * investigations, and in one of them the only evidence the payment started.
     *
     * It stays excluded generally, because it is 1.9M lines a day, but not when
     * the user has said they are investigating a payment.
     */
    chatterExceptions: ['"lSeqRemaining"'],
    options: [
      {
        id: 'forte',
        label: 'Forte',
        serviceUi: 'Forte',
        providerUrn: 'urn:provider-id:forte',
      },
      {
        id: 'paypal',
        label: 'Paypal Commerce',
        serviceUi: 'Paypal Commerce',
        providerUrn: 'urn:provider-id:paypal-ppcp',
      },
      {
        id: 'securepay',
        label: 'SecurePay',
        serviceUi: 'SecurePay',
        // SecurePay is Payrix on the wire. Confirmed on the facet.
        providerUrn: 'urn:provider-id:payrix-multimerchant',
      },
    ],
  },
  {
    id: 'documents',
    label: 'Documents',
    fields: [capId],
    // Measured: document 229,477, EDMS 154,289, DocumentService 150,809,
    // upload 19,152, attachment 3,319, BDOCUMENT 223, FileKey 48. Documents are
    // a far larger share of biz volume than payments, so this scope cuts less --
    // 2.14M down to 92,184 once chatter and chronic patterns go too, against
    // 13,588 for payments. `*laserfiche*` measured 0 here and is left out.
    bizMarkers: [
      '*document*',
      '*EDMS*',
      '*DocumentService*',
      '*attachment*',
      '*upload*',
      '*BDOCUMENT*',
      '*FileKey*',
    ],
    options: [
      {
        id: 'acds',
        label: 'ACDS',
        serviceUi: 'ACDS',
      },
      {
        id: 'ads',
        label: 'ADS',
        serviceUi: 'ADS',
        fields: [
          {
            // ADS access logs carry the document key in the query string. This
            // is the only per-document handle on that tier.
            id: 'fileKey',
            label: 'File key',
            placeholder: 'FileKey value from the download URL',
            hint: 'ADS logs the document key in the access-log query string.',
            clause: (v) => `*FileKey=${v.trim()}*`,
          },
        ],
      },
    ],
  },
  {
    id: 'construct',
    label: 'Construct',
    // Measured: apis/v4 41,577, restapis 22,137, RecordModel 14,847, INN 570.
    // `*capi*` measured 262,391 and is deliberately EXCLUDED -- too broad, it
    // matches unrelated substrings and would undo the scoping.
    bizMarkers: ['*restapis*', '*apis/v4*', '*RecordModel*', '*INN*'],
    options: [
      {
        id: 'capi',
        label: 'Construct API',
        fields: [
          {
            id: 'endpoint',
            label: 'Endpoint',
            placeholder: '/apis/v4/documents',
            hint: 'Matched against the logged MethodName, e.g. "GET /apis/v4/documents/2573836".',
            clause: (v) => `@Properties.log.MethodName:*${v.trim()}*`,
          },
          {
            id: 'traceId',
            label: 'Trace ID',
            placeholder: '260828163457811-2e67f1d8',
            hint: 'The only handle on CAPI error lines, which carry no agency or environment. Also joins the trace to what the back end returned.',
            /*
             * Free text, not the facet. The trace ID reaches the biz tier but
             * only as message text -- the facet form finds nothing there. So
             * this clause is correct as it stands and must not be "improved"
             * into `@Properties.log.TraceId:`.
             */
            clause: (v) => `*${v.trim()}*`,
            /*
             * The biz tier is where a frontline user sees what the API actually
             * returned: `The response size is 50 Bytes ... TraceId is: {id}.
             * Response code is 200`. Two independent gates were destroying that
             * join, and either one alone looked like the tool working.
             *
             * Measured over 24h: 21,850,112 biz lines carry "TraceId is". Of
             * those, 40 survive the Construct markers, and 0 survive the
             * response-size chatter exclusion. End to end on a real trace, the
             * result was 4 lines cut to 3 with the biz line -- the answer --
             * removed.
             *
             * Both are attached to the field rather than the category because
             * they are only affordable once a trace ID has narrowed the search.
             */
            bizMarkers: ['"TraceId is"'],
            chatterExceptions: ['"The response size is"'],
          },
        ],
      },
    ],
  },
];

export function findCategory(id: string | undefined): ScopeCategory | undefined {
  return id ? SCOPES.find((c) => c.id === id) : undefined;
}

export function findOption(
  categoryId: string | undefined,
  optionId: string | undefined
): ScopeOption | undefined {
  if (!optionId) return undefined;
  return findCategory(categoryId)?.options.find((o) => o.id === optionId);
}

/**
 * The extra markers and chatter exceptions contributed by fields that currently
 * have a value, merged with the category's own.
 *
 * Field-level entries are conditional by design: they are only affordable once
 * an identifier has narrowed the search. See `ScopeField.bizMarkers`.
 */
export function activeScopeExtras(
  categoryId: string | undefined,
  optionId: string | undefined,
  values: Record<string, string> | undefined
): { bizMarkers: string[]; chatterExceptions: string[] } {
  const category = findCategory(categoryId);
  const bizMarkers: string[] = [];
  const chatterExceptions = [...(category?.chatterExceptions ?? [])];

  if (values) {
    for (const field of fieldsFor(categoryId, optionId)) {
      if (!values[field.id]?.trim()) continue;
      bizMarkers.push(...(field.bizMarkers ?? []));
      chatterExceptions.push(...(field.chatterExceptions ?? []));
    }
  }

  return { bizMarkers, chatterExceptions };
}

/** Every field in play for the current selection, category-level then option-level. */
export function fieldsFor(
  categoryId: string | undefined,
  optionId: string | undefined
): ScopeField[] {
  const category = findCategory(categoryId);
  if (!category) return [];
  const option = findOption(categoryId, optionId);
  return [...(category.fields ?? []), ...(option?.fields ?? [])];
}
