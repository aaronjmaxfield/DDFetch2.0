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
 * So: one dropdown for the area (Payment, Documents, Records, Reports and so
 * on), a second for the specific provider or service where one exists, and only
 * then the fields that are worth asking for in that context. Collapsed it is SMALLER than the block it
 * replaces, which is what keeps the no-scrollbar goal reachable; expanded it is
 * only bigger when the user has deliberately asked for more.
 *
 * The fast path is untouched. Civic Platform, Citizen Access and Construct API
 * are still checkboxes at the top, so "just give me biz and ACA" is zero extra
 * clicks.
 *
 * There is deliberately no Construct scope CATEGORY. Construct lines live in
 * `service:capi` and its siblings, which the Construct API checkbox reaches
 * through `buildCapiBranch` -- a category's `bizMarkers` only narrow the BIZ
 * tier, so the category did almost nothing visible while implying it did. The
 * checkbox and its measured branch are untouched.
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
  /** Chronic phrases to stop excluding while this field has a value. */
  chronicExceptions?: string[];
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
  /**
   * AND-ed onto the whole query when this option is selected, the same way
   * `providerUrn` is.
   *
   * Custom payment adapters need this because they have neither a service of
   * their own nor a `@PROVIDER` value. Measured 2026-08-28: `@PROVIDER` holds
   * exactly six values estate-wide over 30 days -- forte, payrix-multimerchant,
   * public-portal, paypal-ppcp, epayments3, invalid-test-provider -- and no
   * custom adapter carries any of them. MILARA, SACCO, BIRMINGHAM and CFW each
   * produce ZERO `payment-adapter-service` and ZERO `app-pci-payment-adapter`
   * lines over 7 days, while Forte agency DELAND produces 7,795. The entire
   * custom-adapter population lives on the ACA tier and is identified only by
   * `@logger.name`.
   */
  extraClause?: string;
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
  /**
   * Chronic phrases NOT to exclude when this category is selected.
   *
   * For a category whose entire subject IS the chronic pattern. Reporting is the
   * case: `"report takes more than"` is the pattern that created the chronic
   * tier, and hiding it from a reporting search hides the answer. Measured with
   * the reporting markers in place, the tool returned 1 warning for LEECO, 1 for
   * FDNY and zero for three other agencies.
   */
  chronicExceptions?: string[];
  /**
   * Force the `emse.log` identity arm on for this category.
   *
   * Measured on four agencies across two environments and all three original
   * scopes: the arm adds +1.0% to +40.0% lines and EXACTLY ZERO errors, every
   * time. The zero is structural rather than lucky -- `filename:emse.log` is
   * 20,558,384 lines and 100% `status:info`, even though 1,992,107 of them
   * contain the token `ERROR` and 1,905,251 carry a full `aa_exception` block
   * with the failing SQL. So it is nearly free, and it is where EMSE and
   * batch-script failures actually live.
   */
  forceEmse?: boolean;
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

/*
 * Declared in whatever order is convenient to read; exported alphabetically.
 * Sorting at the source means the array and the dropdown cannot drift apart.
 */
const CATEGORIES: ScopeCategory[] = [
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
      {
        /*
         * ONE broad option for all of them, and that is not a compromise -- it
         * mirrors the implementation. There are 115+ distinct adapter names
         * across 372 agencies, because the name is a free-text Standard Choice
         * (`Paymentus_prod`, `GQ_PAYHUB_PAYMENTUS`, `VelosimoCyberSource_ProdIO`,
         * `CEPAS_2_PRD`, `ButtePayGovAdapter`). Per-adapter options are
         * infeasible, and a frontline user could not pick from such a list
         * anyway. But Accela has only ONE generic code path for all of them, and
         * the ACA logs expose it as a parsed facet.
         *
         * Measured 24h: MILARA 20,114 lines / 718 errors, COSA 9,002 / 307, CFW
         * 5,163 / 187, BIRMINGHAM 215 / 4, SACCO 137 / 0. So the "broad option
         * returns too much to be useful" failure mode does not occur. INDY is
         * the outlier at 496,430 (CityBase, very high volume).
         *
         * HONEST CAVEAT: this is the generic ACA payment path, not a
         * custom-adapter-only path. Custom adapters use it exclusively, but
         * Forte touches the shared page loggers too -- pure-Forte LEECO returns
         * 1,901 lines and 6 errors here. It narrows to the right surface; it
         * does not prove the adapter is custom.
         */
        id: 'custom-adapter',
        label: 'Custom / third-party adapter',
        extraClause:
          'service:aca @logger.name:(Payment_PaymentRedirect OR Payment_PaymentPostback OR PayRedirect OR Accela.ACA.Web.Payment.InternalPayment OR Accela.ACA.Web.Payment.PaymentHelper OR Accela.ACA.Web.Payment.PaymentStatusEvent OR Accela.ACA.Web.Cap.PaymentCompletion OR Accela.ACA.Web.Cap.PaymentResult OR Accela.ACA.Web.Component.Payment)',
        fields: [
          {
            id: 'adapterName',
            label: 'Adapter name',
            placeholder: 'Paymentus_prod, CEPAS_2_PRD, TellerOnline_Prod',
            /*
             * The hint carries the discovery query because that is the single
             * most useful thing found in the whole audit: nobody can guess a
             * value from a 115-entry free-text list, and this answers it from
             * the agency code alone. Verified returning `CEPAS_2_PRD` (MILARA),
             * `OPCoBrandPlus` (SACCO), `Payment_Gateway` (COSA) and
             * `TellerOnline_Prod` (BIRMINGHAM).
             */
            hint: 'Leave blank if you do not know it -- you still get the agency\'s payment traffic. To find it, search: service:aca @agencycode:{AGENCY} @logger.name:EPaymentConfig -- every line is the answer.',
            clause: (v) => `*${v.trim()}*`,
          },
        ],
      },
      {
        /*
         * The one custom adapter that earns its own option. It is the only one
         * with its own code classes, the only one named in a biz-tier line, the
         * only route to back-office custom-adapter activity -- and it logs
         * informational lines at ERROR severity, which is a live triage hazard
         * for 17 agencies.
         */
        id: 'cobrandplus',
        label: 'CoBrandPlus / Official Payments',
        /*
         * ACA loggers only. The builder exempts non-ACA lines automatically, so
         * the biz tier comes through under the category's payment markers --
         * which is what reaches `Provider transaction details for OPCOBrandPlus`
         * along with the generic F4PAYMENT and receipt lines. Naming the biz
         * line explicitly here would have EXCLUDED those generic lines.
         */
        extraClause:
          'service:aca @logger.name:(Accela.ACA.Web.Payment.CoBrandPlusPayment OR Accela.ACA.Web.Payment.CoBrandPlusHandler OR Payment_PaymentRedirect OR Payment_PaymentPostback)',
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
    id: 'gis',
    label: 'GIS / Parcels',
    /*
     * The "60% is one tenant" reading that nearly killed this category was an
     * artefact of the word "parcel". LANE_CO holds 812,555 of the estate's
     * 820,978 `*ParcelScript*` errors -- one broken Oregon EMSE script -- but 2
     * of 792,240 `*GIS*` errors, 0 of 259,564 `*ParcelService*` and 0 of 48,048
     * `*post2AAGIS*`. Real category, dozens of production tenants, four regions.
     *
     * Scoped against unscoped, 24h: MECKLENBURG US PROD 4,307,889 -> 61,883
     * (1.44% kept), COSA 4,839,512 -> 236,687, BARRIE CA PROD 301,880 -> 5,702.
     * 100% retention on all 19 named error families.
     *
     * `*APO*` is REJECTED. It adds 196,579 errors of which 169,097 are
     * `IJ000453 ... FROM RSERV_PROV`, a generic agency-registry query caught
     * through one incidental column name -- it would make the category's error
     * count six times larger and 96% wrong.
     *
     * `*parcel*` needs no table companions: `*B3PARCEL*`, `*B1_PARCEL_NBR*` and
     * `*L1_PARCEL_NBR*` each add exactly 0, because "parcel" is a CONTIGUOUS
     * substring of `b1_parcel_nbr`. The opposite of the convFee / CONV_FEE case,
     * which fails only because the substring would have to span the underscore.
     *
     * `*GIS*` also matches "regis" (register, registry) -- 18.5% of its volume.
     * Accepted deliberately: the residue is 29-756 lines per agency, and the
     * precise alternative under-matches by 57,619 errors. The exact-token form
     * does not even match `GISGeometryBusiness`.
     */
    bizMarkers: [
      '*parcel*',
      '*GIS*',
      '*MapService*',
      '"GovXML Response="',
      '"External APO Restful API"',
    ],
    fields: [
      {
        id: 'parcelNumber',
        label: 'Parcel number',
        placeholder: '159-211-12, 04704452, 016A00250026',
        hint: 'Formats are agency-specific. Paste it exactly as the agency writes it.',
        clause: (v) => `*${v.trim()}*`,
        /*
         * Load-bearing, not a refinement. A parcel reaches parcel work through
         * `Request path is: /v4/records/{id}/parcels`, and `"Request path is:"`
         * is in ROUTINE_CHATTER. Measured GIS-scoped on MECKLENBURG: parcel
         * 04704452 has 6 lines, 0 survive the scope, 4 survive with this.
         */
        chatterExceptions: ['"Request path is:"'],
      },
      {
        id: 'capIdForParcels',
        label: 'CAP ID',
        placeholder: '26ABC-00000-01304',
        hint: 'Finds the parcels attached to a record.',
        clause: (v) => `*${v.trim()}*`,
        // Same reason: CAP REC26-00000-03D2V has 29 lines, 0 scoped, 1 with this.
        chatterExceptions: ['"Request path is:"'],
      },
      {
        id: 'mapService',
        label: 'Map service',
        placeholder: 'COHB',
        hint: 'The agency GIS map service name, from the GIS configuration.',
        // A colon inside a wildcard is parsed as a facet: `*Map Service: COHB*`
        // returns 0, the quoted form returns 285.
        clause: (v) => `("Map Service: ${v.trim()}" OR *MapService*${v.trim()}*)`,
      },
    ],
    options: [],
  },
  {
    id: 'emse',
    label: 'EMSE scripts',
    /*
     * Real category, not one broken tenant: `*aa.emse* status:error` reaches 388
     * distinct agencies in 24h. LANE_CO's 58% share is a single defect,
     * `ParcelScript/deleteParceDistrictForDaily`; strip it and 387 agencies share
     * 383,796 errors, 150 of them with 100 or more.
     *
     * Reductions with the emse arm forced on, 24h: LEECO 90.2%, CFW 94.6%,
     * CLARKCO 86.9%, MANATEE 99.5%, BARRIE 95.6%. Every EMSE error family
     * retained at 100%, `- THROW` included.
     *
     * `- THROW` is NOT a marker. It is a platform-wide convention: outside EMSE
     * it is 729,425 lines and 724,702 errors of I18NHelper, TextMessageResources
     * and web-service throws. As a category marker it injected 183,605 unrelated
     * errors against CFW's 2,726 real ones. It lives on the trace-ID field.
     *
     * `*ScriptEngine*` measured 25 lines estate-wide and is not here.
     *
     * Two markers are quoted because the wildcard form matches both tokens
     * ANYWHERE on the line: `*Script Error*` is 2,270,869 lines against 10,639
     * quoted, and on LANE_CO the wildcard form returns 682,551 lines with zero
     * errors. This is the inverse of the usual positive-matching rule.
     */
    bizMarkers: [
      '*emse*',
      '*ScriptDAOOracle*',
      '"Run Expression"',
      '"Script Error"',
      '"Action Cancelled"',
    ],
    forceEmse: true,
    fields: [
      {
        id: 'scriptOrEvent',
        label: 'Script or event name',
        placeholder: 'ISB:PERMITTING, or the script name',
        hint: 'Use the script name. The short event codes are not searchable terms -- ASA alone matches 1,067,976 unrelated lines.',
        // A colon inside a wildcard is parsed as a facet and returns HTTP 400,
        // so a value containing one switches to the quoted form.
        clause: (v) => {
          const t = v.trim();
          return t.includes(':') ? `"${t}"` : `*${t}*`;
        },
        warn: (v) =>
          /^(ASA|ASB|PRA|ACUA|WTUA)$/i.test(v.trim())
            ? `"${v.trim()}" is an event abbreviation rather than a searchable token, and it matches unrelated text. Search the script name instead, or use the trace ID.`
            : undefined,
      },
      capId,
      {
        id: 'emseTraceId',
        label: 'Trace ID',
        placeholder: 'W-20260101120000000-1a2b3c4d',
        hint: 'From the script error line. This is the only way to see the caller that triggered the script.',
        clause: (v) => `*${v.trim()}*`,
        /*
         * On a real trace the category markers cut 9 lines to 4, and the first
         * casualty is the caller -- `InspectionWebService/batchScheduleInspections
         * - THROW` -- which is the answer. These restore all 9. As category
         * markers they would have cost +290% and +332%.
         */
        bizMarkers: ['"THROW"', '*TraceId*'],
      },
    ],
    options: [],
  },
  {
    id: 'records',
    label: 'Records',
    /*
     * The chronic problem here is THREE separate defects, not one, and two of
     * the names in circulation were wrong. `INNHelper.doINNNRecordModel()` is
     * really `I18NHelper/doI18N4RecordModel()`, and it is a different family from
     * `getCapTypeByPK(:null/null/null/null)`, which is different again from
     * `capModel and serviceProviderCode of capId should not be null`. Measured
     * 24h estate-wide: 1,162,884 / 164,754 / 83,418 lines, all ~100% error --
     * 1.41M a day between them, and 78.2% of every biz-tier error at LEECO.
     *
     * Each needed a different treatment. Family A is in CHRONIC_PATTERNS (300
     * sampled events, one distinct message string, no stack and no identifier,
     * so it cannot contain an answer). Family B is designed OUT of the markers
     * instead -- `*getCapTypeByPK*` and `*CapTypeService*` sit on the recordType
     * field below, which drops the family from 164,754 lines to 20 while
     * returning real record-type evidence the moment a user names a type. Four
     * chronic negations for B were tried and all four failed: the phrase pair
     * that matches 164,754 lines positively removes exactly ZERO negatively.
     * Family C belongs to Construct, whose `*RecordModel*` marker is 99.8% that
     * defect on the biz tier.
     *
     * Results on seven agency/environment pairs across four environments and
     * three regions: LEECO 3,031,687 lines / 281,940 errors -> 282,655 / 2,252;
     * SEATTLE PROD -> 83,418 / 15,201; LJCMG -> 17,014 / 5,899. Both named closed
     * investigations survive. The inverse test confirms the misses are GIS,
     * workflow and AES errors -- other categories' work, not lost records
     * evidence.
     *
     * No `chatterExceptions`: audited on all seven pairs, routine chatter removes
     * 0 errors and 0 warns under this scope.
     */
    bizMarkers: [
      '*B1PERMIT*',
      '*CapBusiness*',
      '*CapService*',
      '*CapWebService*',
      '*capModel*',
      '*createCap*',
      '*CapScript*',
      '*getCapID*',
      '*CapIDModel*',
      '*CapDetailModel*',
      '*B1EXPIRATION*',
      '*TMP_CAP*',
      '*B1_ALT_ID*',
      '*CapBll*',
      '*CapUtil*',
    ],
    fields: [
      capId,
      {
        id: 'recordType',
        label: 'Record type',
        placeholder: 'BLD_GENERAL',
        hint: 'The record type as configured, not the display label.',
        clause: (v) => `*${v.trim()}*`,
        /*
         * These two are here rather than in the category markers on purpose. As
         * category markers they drag in the whole
         * `getCapTypeByPK(:null/null/null/null)` family -- 164,754 lines a day of
         * pure noise. Attached to this field they drop it to 20 lines while
         * returning the record-type evidence the user asked for.
         */
        bizMarkers: ['*getCapTypeByPK*', '*CapTypeService*'],
      },
    ],
    options: [],
  },
  {
    id: 'batch',
    label: 'Batch jobs',
    /*
     * The most evenly distributed of the new categories, and the strongest
     * evidence of a genuine estate-wide problem: US PROD batch errors 224,057
     * with the top tenant at 6.0%, and the 200-bucket ceiling covering only
     * 50.1% of the population -- so more than 200 tenants logged a batch error
     * in a single day. The tail is real customers at a flat ~410 each.
     *
     * TWO markers, and the underscore twin is the finding. Estate-wide 24h,
     * `*BATCH_JOB*` AND NOT `*batchjob*` is 467,843 lines of which 439,277 are
     * errors -- MORE errors than `*batchjob*` finds in total (401,795). Those are
     * the SQL-level failures. Per agency `*batchjob*` alone misses 97.9%
     * (SANDIEGO), 59.9% (BALTCO) and 59.7% (LEECO) of batch errors, and the
     * error-level intersection is exactly 0 on all six agencies tested.
     *
     * Rejected with numbers: `*batch*` (residue is the chronic slow-report
     * warning plus user-initiated ACA bulk actions), `*Quartz*` (matches
     * "ROSE QUARTZ LN"), `*_scheduler*` (a different subsystem entirely).
     */
    bizMarkers: ['*batchjob*', '*BATCH_JOB*'],
    /*
     * `"BatchJobLog"` is in the chronic tier because it carries real errors that
     * bury other investigations -- but for THIS category it is the subject.
     * Errors with it hidden against kept: CGS 28 -> 879 (96.8% lost), BALTCO
     * 3,207 -> 5,355. Sharper still, with it hidden the warn count is ZERO on six
     * of six agencies, because `Batch Job was deleted` and `was interrupted` are
     * warns and they carry the full job dump. Cost of this exception to other
     * scopes: 0 errors across 9 of 9 scope-agency pairs.
     */
    chronicExceptions: ['"BatchJobLog"'],
    forceEmse: true,
    fields: [
      {
        id: 'batchJobName',
        label: 'Batch job name',
        placeholder: 'BATCH_EH_AGING_CREATESETS, or a number',
        hint: 'There is no separate job ID -- the name carries it, and some job names are numbers. Note that EMSE print output from a batch script goes to the batch job output record, not to emse.log.',
        clause: (v) => `*${v.trim()}*`,
      },
      {
        id: 'batchScheduledDate',
        label: 'Scheduled date',
        placeholder: '2026-08-28',
        hint: 'Matched against the StartDate in the job dump.',
        clause: (v) => `*StartDate=${v.trim()}*`,
      },
    ],
    options: [],
  },
  {
    id: 'reporting',
    label: 'Reports',
    /*
     * Five engines behind two message shapes. SSRS, Crystal, Ad Hoc, Insights
     * and agency-custom REST services all funnel through
     * `Reporting warning - report takes more than 60 sec: {...}` and
     * `Reporting Errors: {...}`, so the ENGINE NAMES are the wrong markers --
     * `*ReportServer*`, `*CReport*`, `*AdhocReport*` and `*XReport.aspx*`
     * contribute exactly 0 unique biz-tier lines.
     *
     * The one-agency trap fired here in its clearest form. LEECO is 100% Crystal
     * (`*ReportServer*` = 0, `*CReport*` = 28); FDNY is 100% SSRS
     * (`*ReportServer*` = 1,829, `*CReport*` = 0). Measuring on either agency
     * alone would have discarded the other's entire reporting surface.
     *
     * `*NoReportAssignError*` is 88.6% of all reporting errors in the estate and
     * stays VISIBLE: hiding it costs 96.5% of FDNY's and 99.1% of
     * WINEAUSTRALIA's reporting errors. The `"BatchJobLog"` lesson applied.
     *
     * "Empty report" is not logged at all -- five candidate shapes each measured
     * zero -- so there is deliberately no field for it.
     */
    bizMarkers: [
      '"report takes more than"',
      '"Reporting Errors"',
      '*NoReportAssignError*',
      '*ReportButtonProperty*',
    ],
    /*
     * Without this the category is pointless. With the markers in place but the
     * pattern still hidden, the tool returned 1 warning for LEECO, 1 for FDNY and
     * ZERO for TPCHD, BARRIE and WINEAUSTRALIA. Three real tickets, before and
     * after: 0 rows -> 331, 0 rows -> 857, and 128 -> 12,985.
     *
     * `"It is risky to retrieve too many records"` is deliberately NOT exempted.
     * The brief assumed it was a reporting pattern; measured, it is 35,636 lines
     * of which ZERO carry any reporting marker, and 7,520 are
     * `SELECT * FROM B1PERMIT` record searches. Exempting it recovered 0 lines on
     * all five agencies.
     */
    chronicExceptions: ['"report takes more than"'],
    fields: [
      {
        id: 'reportName',
        label: 'Report name',
        placeholder: 'cReceiptLee_All_ACA_new',
        hint: 'As the user sees it. Spaces are safe here.',
        clause: (v) => `*${v.trim()}*`,
      },
      {
        id: 'reportRecord',
        label: 'Record number or CAP ID',
        placeholder: '26ABC-00000-01304',
        hint: 'Reports are the one place the on-screen record number does appear, so either form works.',
        clause: (v) => `*${v.trim()}*`,
      },
      {
        id: 'reportId',
        label: 'Report ID',
        placeholder: '1267',
        hint: 'Numeric ID from the report configuration.',
        // `*reportID : 1267*` is HTTP 400 because of the colon, not the space --
        // verified that `*a : b*` also 400s.
        clause: (v) => `("reportID : ${v.trim()}" OR *reportID=${v.trim()}*)`,
      },
    ],
    options: [],
  },
];

/** Alphabetical by label, because that is the order the dropdown shows. */
export const SCOPES: ScopeCategory[] = [...CATEGORIES].sort((a, b) =>
  a.label.localeCompare(b.label)
);

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
): { bizMarkers: string[]; chatterExceptions: string[]; chronicExceptions: string[] } {
  const category = findCategory(categoryId);
  const bizMarkers: string[] = [];
  const chatterExceptions = [...(category?.chatterExceptions ?? [])];
  const chronicExceptions = [...(category?.chronicExceptions ?? [])];

  if (values) {
    for (const field of fieldsFor(categoryId, optionId)) {
      if (!values[field.id]?.trim()) continue;
      bizMarkers.push(...(field.bizMarkers ?? []));
      chatterExceptions.push(...(field.chatterExceptions ?? []));
      chronicExceptions.push(...(field.chronicExceptions ?? []));
    }
  }

  return { bizMarkers, chatterExceptions, chronicExceptions };
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
