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

/** The clause to AND onto a query, or '' when the list is empty. */
export function routineChatterExclusion(): string {
  if (!ROUTINE_CHATTER.length) return '';
  return ROUTINE_CHATTER.map((p) => `-${p.phrase}`).join(' AND ');
}
