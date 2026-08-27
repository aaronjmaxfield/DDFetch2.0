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
