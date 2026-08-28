/**
 * Shared contract between the query engines.
 *
 * DDFetch has two engines: `legacy` reproduces the queries the tool has always
 * generated, `v2` is the corrected implementation. Both consume the same input
 * so their output can be compared for identical form state.
 */

export interface QueryInput {
  servProvCode: string;
  host: string;
  environment: string;
  /** 'Civic Platform' | 'Citizen Access' | 'CAPI' */
  applications: string[];
  /** 'Forte' | 'Paypal Commerce' | 'ACDS' | 'ADS' | 'SecurePay' */
  additionalServices: string[];
  /** Raw text as typed, before any wildcarding. */
  additionalParams: string;
  /**
   * Include `av.indexer` in the biz-tier branch. Default false.
   *
   * The indexer is agency-tagged, so it passes the identity filter and used to
   * dominate every biz search -- 57% of the lines returned for a real payment
   * investigation, all of them `status:info`. It is worth having only when the
   * search itself is about indexing.
   *
   * Optional so the legacy engine and existing callers are unaffected; both
   * engines treat `undefined` as false.
   */
  includeIndexer?: boolean;
  /**
   * Include the EMSE log in the biz-tier branch. Default false.
   *
   * emse.log carries neither @SERV_PROV_CODE nor @JNDI, so it needs a free-text
   * arm of its own or it is entirely invisible -- 14.9% of US PROD av.biz. It is
   * also bulk: 7,525 info-only lines against 1,052 for the rest of the biz
   * branch, measured on one agency over six hours. Off by default, and forced on
   * for the rows where it is the only biz log that exists.
   */
  includeEmse?: boolean;
  /**
   * Scoped search, the progressive-disclosure replacement for the additional-
   * service checkboxes. See scopes.config.ts.
   *
   * Entirely optional: when `category` is unset the engine behaves exactly as it
   * did, so the fast path -- tick Civic Platform, hit Fetch -- gains no clicks.
   * When set, `option` selects the provider or service and `fields` carries the
   * scoped identifiers keyed by ScopeField.id.
   */
  scope?: {
    category?: string;
    option?: string;
    fields?: Record<string, string>;
  };
  /**
   * Hide routine chatter -- the log lines that appear in every search and cannot
   * contain a failure. See noise.config.ts for the list and the evidence.
   *
   * Defaults to ON, which is a deliberate choice for the frontline audience: the
   * useful default is the readable one, and the toggle is there for anyone who
   * needs the raw stream. Measured effect on a real Forte search: 1,817 lines
   * to 574, with all 81 errors and all 116 warnings retained.
   *
   * `undefined` means on. Pass `false` explicitly to get everything.
   */
  hideRoutineChatter?: boolean;
  /**
   * Include chronic conditions -- real errors and warnings that are constant in
   * the environment rather than related to any one search. Defaults to OFF.
   *
   * Unlike routine chatter these are genuine failures, so hiding them is always
   * announced in the warnings. On the busiest Forte agency the slow-report
   * warning alone is ~60,000 lines in 24 hours, 99.6% of everything remaining
   * after scoping -- it buries the payment failures beside it.
   */
  showChronic?: boolean;
  /**
   * Restrict the biz tier to the selected scope category. Defaults to ON when a
   * category is chosen, because the biz branch is otherwise unbounded.
   *
   * Measured on the busiest Forte agency, US PROD, 24 hours: 2,138,287 lines and
   * 218,581 errors unscoped, against 74,696 and 74 with the payment markers. Of
   * those 218,581 errors only 74 concern payments, so the scope improves the
   * signal as much as the volume.
   */
  scopeBizTier?: boolean;
}

export interface QueryResult {
  /** The Datadog query, or '' when errors is non-empty. */
  query: string;
  /**
   * Conditions the user should know about but which do not block the search --
   * e.g. an environment where ACA logs are not collected, so that filter was
   * dropped. The legacy engine dropped these silently.
   */
  warnings: string[];
  /** Conditions that prevent a query being built at all. */
  errors: string[];
}

export type EngineId = 'legacy' | 'v2';

export interface QueryEngine {
  readonly id: EngineId;
  readonly label: string;
  build(input: QueryInput): QueryResult;
}

export function emptyResult(): QueryResult {
  return { query: '', warnings: [], errors: [] };
}
