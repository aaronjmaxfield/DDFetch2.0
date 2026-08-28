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
            hint: 'The only handle on CAPI error lines, which carry no agency or environment.',
            clause: (v) => `*${v.trim()}*`,
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
