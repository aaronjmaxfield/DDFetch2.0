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
    /*
     * A FACET negation, not a phrase -- and safe precisely because of that. A
     * facet negation only excludes lines where the facet holds that value, so
     * every line without the facet survives, and the biz tier is untouched.
     *
     * Measured 24h estate-wide: 1,351,248 lines, ALL `status:info`, no error or
     * warn bucket at all. Over 30 days it is 10,935,188 lines with zero errors
     * and zero warns, so the zero is structural rather than a lucky window.
     *
     * Worth having because it is a large pre-existing noise source nobody had
     * noticed: many agencies' adapter names contain the word "Payment", so these
     * config-dump lines match payment searches. It cuts 74% off COSA's payment
     * scope, 52% off CFW and 51% off SBC.
     *
     * NOTE the facet spelling: `@logger.name` with a DOT on ACA. `@logger_name`
     * with an underscore is the ConfigStore and ACDS spelling and returns zero
     * buckets here. Free text reaches neither.
     */
    phrase: '@logger.name:EPaymentConfig',
    what: 'ACA dumping the payment adapter configuration on every page load',
  },
  {
    /*
     * The pair logged on every document operation for an agency with no
     * document group. Measured 2026-09-22: 2,041,296 lines estate-wide in 24h
     * and 7 days of it, all `status:info`, no error or warn bucket; 107,825 of
     * each on OKC PROD alone. Only the `null` value is excluded -- a line
     * naming a real group survives.
     */
    phrase: '"EDMS server docGroup=null"',
    what: 'EDMS reporting that no document group is set',
  },
  {
    phrase: '"Document Group Code: null"',
    what: 'The same, logged a second time by the document tier',
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
  {
    /*
     * Promoted out of ROUTINE_CHATTER on 2026-08-28. It never belonged there:
     * measured over 7 days it carries 60,471,081 info lines AND 373
     * `status:error` lines, so it broke the one rule that list has. A
     * documents-scoped week on one production agency lost 74 real errors to
     * this pattern alone, while the other ten patterns lost zero between them.
     *
     * Not deleted, because it is 10.4M lines a day. Moved to the tier where
     * hiding is announced and reversible, which is what should have happened
     * the moment it was found to contain errors.
     */
    phrase: '"EDMS Config="',
    what: 'EDMS configuration dumps on page load (these include some real errors)',
  },
  {
    /*
     * Promoted out of ROUTINE_CHATTER on 2026-08-28, and it was the whole of
     * that tier's error loss. Measured per pattern on LEECO PROD over 24h: nine
     * of the ten removed exactly zero errors and zero warns, and this one
     * removed 158 errors and 10 warns on its own.
     *
     * They are not heartbeats. They are
     * `BatchJobObserver/handleJobs(): Exception occurs when try to get local
     * server jobs from database` and `updateLocalServerTtl(): Exception occurs
     * when update TTL`, arriving in bursts -- database failures stopping batch
     * jobs from being scheduled. "My nightly batch did not run" is a real
     * ticket, and this pattern silently answered it with nothing.
     *
     * Note this was measured clean on the agency it was first added against.
     * That is the recurring lesson: one agency is not evidence.
     */
    phrase: '"BatchJobLog"',
    what: 'Batch distributor and worker chatter (this also hides batch job failures)',
  },
  {
    /*
     * Chronic rather than routine, because every one of these is `status:error`
     * and the routine tier must not remove errors. Measured 24h estate-wide:
     * 9,292 lines, 100% error, spread widely -- MILARA 638, FDNY 499, TREC 378,
     * DALLASTX 364, DENVER 345, COSA 301.
     *
     * The message is `Can't get the correct information from cache['1316757'],
     * add current data to cache.` -- an ACA cache miss that then repopulates the
     * cache. Error severity, self-healing, and on MILARA it is 638 of that
     * agency's 718 custom-adapter errors, so leaving it in buries whatever the
     * user is actually looking for.
     */
    phrase: '"add current data to cache"',
    what: 'ACA cache misses that then repopulate the cache (logged as errors)',
  },
  {
    /*
     * The single largest error family in the estate: 1,162,884 lines in 24h, all
     * ~100% error, and 78.2% of every biz-tier error at one production agency
     * when combined with its two relatives.
     *
     * It earns the chronic tier on evidence rather than volume. 300 sampled
     * events produced ONE distinct message string, with no stack trace and no
     * identifier of any kind -- so it cannot contain an answer to anything. That
     * is the test for this tier, not size.
     *
     * Named correctly here: it is `I18NHelper/doI18N4RecordModel()`, not
     * `INNHelper.doINNNRecordModel()` as previously recorded, and it is a
     * SEPARATE family from both `getCapTypeByPK(:null/null/null/null)` and
     * `capModel and serviceProviderCode of capId should not be null`.
     */
    phrase: '"doI18N4RecordModel"',
    what: 'A known platform defect that logs one identical line with no detail',
  },
  {
    /*
     * 382,448 lines in 24h, 100% `status:error`, and 96.0% of everything a
     * GIS-scoped MECKLENBURG search returns -- 85,516 of 89,041. It is an
     * `ObjectNotFoundException` logged when a parcel simply has no conditions.
     *
     * Stated cost, because it is not free: a COHB parcel search goes from 22
     * scoped lines to 7.
     */
    phrase: '*getAllParcelCond*',
    what: 'Parcels with no conditions, logged as an exception',
  },
  {
    /*
     * Document timing lines: `[TimeCost: 363(ms), DocumentSize: 3,
     * AGENCY/CAP/26ABC-00000-00001] [...StandardAdaptor.getDocumentList]`, one per
     * adaptor call on every document list. Logged at ERROR, so chronic rather
     * than routine.
     *
     * Measured 2026-09-22. 7 days estate-wide: 4,541,469 lines, 100% error, zero
     * lines off the fixed `[TimeCost: N(ms), ...] [method]` shape, stack trace
     * always empty. Emitted by about fifteen agencies -- SEATTLE 237,764 and OKC
     * 236,540 a day, then BOISE, FRESNO, SUFFOLKCO, LJCMG, TEMPE, STDTEST2019 --
     * presumably a per-agency logging setting. On OKC PROD it was 236,923 of
     * the 241,344 errors a documents-scoped day returned, 98%, and buried a real
     * `(500)Internal Server Error` upload failure.
     *
     * A facet rather than the phrase: the class covers exactly the same lines
     * (zero `DocumentPerformanceTrace` lines lack "TimeCost") and cannot reach
     * text in anything else. Not dropped outright -- the timings are the
     * evidence for a slow-document ticket, which is what the toggle is for.
     */
    phrase: '@className:DocumentPerformanceTrace',
    what: 'Document timing lines ("TimeCost"), logged as errors on every document list',
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

/**
 * The clause to AND onto a query, or '' when nothing is left to exclude.
 *
 * `exceptions` names phrases to keep, for a scope that depends on them as
 * evidence -- see `chatterExceptions` on ScopeCategory. Matching is on the exact
 * phrase string.
 */
export function routineChatterExclusion(exceptions: string[] = []): string {
  const kept = exceptions.length
    ? ROUTINE_CHATTER.filter((p) => !exceptions.includes(p.phrase))
    : ROUTINE_CHATTER;
  return exclusionFrom(kept);
}

/**
 * `exceptions` names chronic phrases to KEEP, for a scope whose whole subject is
 * that pattern.
 *
 * The reporting category is why this exists. `"report takes more than"` is the
 * pattern that forced the chronic tier into existence, and hiding it is right for
 * a payment investigation and absurd for a reporting one. Measured with the
 * reporting markers in place, the tool returned 1 warning for LEECO, 1 for FDNY
 * and ZERO for three other agencies. Three real tickets went from 0 rows to 331,
 * 0 to 857, and 128 to 12,985 once this was exempted.
 *
 * Batch needs it for the same reason in the other direction: `"BatchJobLog"` in
 * the chronic tier took CGS from 879 errors to 28, and zeroed the warn count on
 * six of six agencies -- and the warns are the lines carrying the full job dump.
 */
export function chronicExclusion(exceptions: string[] = []): string {
  return exclusionFrom(keptChronic(exceptions));
}

function keptChronic(exceptions: string[]): NoisePattern[] {
  return exceptions.length
    ? CHRONIC_PATTERNS.filter((p) => !exceptions.includes(p.phrase))
    : CHRONIC_PATTERNS;
}

/**
 * Plain-language summary for the warning shown when chronic patterns are hidden.
 *
 * Deliberately no case change. Lowercasing the whole string turned "EDMS" into
 * "edms" as soon as an acronym joined the list, and lowering just the first
 * character turns it into "eDMS", which is worse. The `what` strings are written
 * to read correctly after a colon, so they are used verbatim.
 */
export function chronicSummary(exceptions: string[] = []): string {
  // Must take the same exceptions as chronicExclusion, or the warning names
  // things that were NOT hidden -- which is worse than no warning, because the
  // user then goes looking for a toggle to recover data that is already there.
  return keptChronic(exceptions)
    .map((p) => p.what)
    .join('; ');
}

/** What a scope deliberately kept, for the positive counterpart warning. */
export function chronicKeptSummary(exceptions: string[]): string {
  return CHRONIC_PATTERNS.filter((p) => exceptions.includes(p.phrase))
    .map((p) => p.what)
    .join('; ');
}
