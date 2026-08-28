/**
 * Routine chatter: log lines that appear in every search regardless of what you
 * are looking for, and that cannot contain the answer.
 *
 * -------------------------------------------------------------------------
 * THE RULE FOR ADDING TO THIS LIST
 * -------------------------------------------------------------------------
 * A pattern only belongs here if, measured against a real search window, it
 * removes ZERO `status:error` and ZERO `status:warn` lines. Volume alone is not
 * enough -- the point of the tool is to find failures, so a filter that hides
 * one is worse than no filter at all.
 *
 * Every entry below was measured that way on a live Forte search (agency in US
 * TEST, 6h window, 1,817 lines). Together they take it to 574 -- a 68%
 * reduction -- while retaining all 81 errors and all 116 warnings.
 *
 * -------------------------------------------------------------------------
 * ONE TRAP, WORTH KNOWING BEFORE YOU EDIT
 * -------------------------------------------------------------------------
 * Datadog ignores punctuation when matching a quoted phrase, so a pattern is
 * broader than it looks. `"Request URL:"` also matches
 * `The Request URL /v4/settings got status 404` -- a real API failure -- because
 * both reduce to the tokens [request][url].
 *
 * And counter-intuitively, the *more specific* form matches MORE:
 *
 *     "Request URL:"       ->  23 lines
 *     "Request URL:https"  -> 178 lines
 *
 * The colon-terminated form under-matches. So `"Request URL:https"` is both
 * safer (it cannot reach the `/v4/...` failures, which are followed by a path
 * rather than a scheme) and more effective. Do not "simplify" it back.
 *
 * Always re-measure after editing. The check is:
 *
 *   {query} AND (status:error OR status:warn) AND ({patterns joined by OR})
 *
 * which must return zero.
 */

export interface NoisePattern {
  /** The Datadog phrase, quoted. */
  phrase: string;
  /** What it is, in plain language -- this is user-facing in the UI listing. */
  what: string;
}

export const ROUTINE_CHATTER: NoisePattern[] = [
  {
    phrase: '"Request URL:https"',
    what: 'ACA logging the full URL and headers of every internal API call',
  },
  {
    phrase: '"Response Headers:"',
    what: 'ACA dumping CORS and cache headers on every response',
  },
  {
    phrase: '"The response size is"',
    what: 'Per-response size and timing lines',
  },
  {
    phrase: '"Default page VirtualPath:"',
    what: 'ACA resolving which page to serve',
  },
  {
    phrase: '"URL for redirect:"',
    what: 'ACA redirect bookkeeping',
  },
  {
    phrase: '"Request path is:"',
    what: 'Config-manager request plumbing',
  },
  {
    phrase: '"BatchJobLog"',
    what: 'Batch distributor and worker heartbeats',
  },
  {
    phrase: '"lSeqRemaining"',
    what: 'Database sequence-number bookkeeping',
  },
  {
    phrase: '"AuditBusiness"',
    what: 'Audit-history write counts',
  },
  {
    phrase: '"Reading Regional Data from Web Service"',
    what: 'Regional data cache loads',
  },
  {
    phrase: '"EDMS Config="',
    what: 'EDMS configuration dumps on page load',
  },
];

/**
 * Chronic conditions: a SECOND tier, and a different thing entirely.
 *
 * These are genuine errors and warnings -- they fail the rule above on purpose.
 * What makes them separate is that they are constant rather than events: the
 * same message tens of thousands of times a day, describing a standing
 * condition in the environment rather than anything the user is investigating.
 *
 * The slow-report warning is the example that forced this tier to exist. On the
 * busiest Forte agency it is ~60,000 warnings in 24 hours, 99.6% of every
 * warning that survived the payment scope. Leaving it in buries the payment
 * failures; dropping it silently would violate the one rule that matters.
 *
 * So: hidden by default, but NEVER silently. The engine emits a warning naming
 * what was hidden, and turning it back on is one flag. A frontline user is told
 * "slow-report warnings are hidden" rather than being left to wonder.
 */
export const CHRONIC_PATTERNS: NoisePattern[] = [
  {
    phrase: '"report takes more than"',
    what: 'Slow-report warnings from the reporting adapter',
  },
  {
    phrase: '"It is risky to retrieve too many records"',
    what: 'Large-result-set SQL warnings',
  },
];

/**
 * Builds an exclusion clause from a pattern list.
 *
 * -------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING A PATTERN TO WILDCARD FORM
 * -------------------------------------------------------------------------
 * The rules for positive matching and for negation are OPPOSITE, and getting
 * the negation wrong empties the entire query rather than failing loudly.
 *
 *   POSITIVE  `*token*` is dependable; quoted phrases under-match and sometimes
 *             match nothing at all. Hence wildcard `bizMarkers`.
 *
 *   NEGATION  A wildcard-wrapped MULTI-WORD phrase matches everything, so the
 *             query returns ZERO rows:
 *
 *               -"report takes more than"   -> 14,048 rows   correct
 *               -*report takes more than*   ->      0 rows   broken
 *               -*XReport.aspx*             -> 14,048 rows   fine, one token
 *
 * So: negations use quoted form for anything containing a space, and wildcards
 * only for single tokens. Both list entries above are multi-word and quoted for
 * exactly this reason.
 */
function exclusionFrom(patterns: NoisePattern[]): string {
  if (!patterns.length) return '';
  return patterns.map((p) => `-${p.phrase}`).join(' AND ');
}

/** The clause to AND onto a query, or '' when the list is empty. */
export function routineChatterExclusion(): string {
  return exclusionFrom(ROUTINE_CHATTER);
}

export function chronicExclusion(): string {
  return exclusionFrom(CHRONIC_PATTERNS);
}

/** Plain-language summary for the warning shown when chronic patterns are hidden. */
export function chronicSummary(): string {
  return CHRONIC_PATTERNS.map((p) => p.what.toLowerCase()).join('; ');
}
