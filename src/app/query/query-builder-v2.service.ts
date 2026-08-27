import { Injectable } from '@angular/core';
import {
  ADDITIONAL_SERVICES,
  EnvironmentDef,
  findEnvironment,
  findHost,
  HostDef,
  ServiceDef,
  ServiceTarget,
} from './environments.config';
import { QueryEngine, QueryInput, QueryResult } from './query-input.model';

/**
 * Corrected query builder.
 *
 * The central change is structural. Accela's logs come in two shapes:
 *
 *   biz tier      -- VM hosts, scoped by @SERV_PROV_CODE / @JNDI / host:
 *   containerised -- AKS services, scoped by service: / env: / agency attribute
 *
 * The legacy engine OR'd these together as though they were scoped alike, which
 * is why selecting a payment service returned every tenant's payment logs in
 * every region: the service branch carried no agency, environment or host
 * filter at all. Here each model is scoped on its own terms and the agency
 * scope is applied to both.
 */
@Injectable({ providedIn: 'root' })
export class QueryBuilderV2Service implements QueryEngine {
  readonly id = 'v2' as const;
  readonly label = 'New (v2)';

  build(input: QueryInput): QueryResult {
    const warnings: string[] = [];
    const errors: string[] = [];

    const host = findHost(input.host);
    if (!host) {
      errors.push(`Unknown host '${input.host}'.`);
      return { query: '', warnings, errors };
    }

    const env = findEnvironment(input.host, input.environment);
    if (!env) {
      errors.push(`'${input.environment}' is not a valid environment for ${host.ui}.`);
      return { query: '', warnings, errors };
    }

    const services = this.resolveServices(input.additionalServices, errors);
    if (errors.length) return { query: '', warnings, errors };

    const agency = input.servProvCode.trim();
    const branches: string[] = [];

    const biz = this.buildBizBranch(input, host, env, agency, warnings);
    if (biz) branches.push(biz);

    const capi = this.buildCapiBranch(input, host, env, agency, warnings);
    if (capi) branches.push(capi);

    const svc = this.buildServiceBranch(services, env, agency, warnings);
    if (svc) branches.push(svc);

    if (!branches.length) {
      errors.push('Select at least one application or additional service.');
      return { query: '', warnings, errors };
    }

    let query = branches.length > 1 ? `(${branches.join(' OR ')})` : branches[0];

    const params = this.formatAdditionalParams(input.additionalParams);
    if (params) query = `${query} AND ${params}`;

    return { query, warnings, errors };
  }

  // ------------------------------------------------------------------ biz tier

  private buildBizBranch(
    input: QueryInput,
    host: HostDef,
    env: EnvironmentDef,
    agency: string,
    warnings: string[]
  ): string {
    const wantsAca = input.applications.includes('Citizen Access');
    // ACA is the front end and Civic Platform the back end, so an ACA search
    // always needs the biz tier too. Preserved from legacy deliberately.
    const wantsBiz = input.applications.includes('Civic Platform') || wantsAca;
    if (!wantsBiz) return '';

    const upper = agency.toUpperCase();
    const lower = agency.toLowerCase();
    const identity: string[] = [`@SERV_PROV_CODE:*${upper}*`];

    if (host.usesJndi) {
      // Facet values are case sensitive, so both casings are needed.
      identity.push(`@JNDI:*${lower}-${env.jndi}*`, `@JNDI:*${upper}-${env.jndi.toUpperCase()}*`);
    }

    if (wantsAca) {
      if (env.acaFilename) {
        identity.push(`filename:*${env.acaFilename(lower)}*`);
        // @agencycode is a real log field and is present on ACA lines that
        // carry no agency token in the message body, which the legacy
        // free-text `*AGCY*` match missed entirely.
        identity.push(`(service:*aca* AND @agencycode:${upper})`);
        identity.push(`(service:*aca* AND *${upper}*)`);
      } else {
        warnings.push(
          `Citizen Access logs are not collected for ${host.ui} ${env.ui}, so the ACA filter was left out. Only Civic Platform logs will be returned.`
        );
      }
    }

    return `((${identity.join(' OR ')}) AND ${env.hostClause})`;
  }

  // ---------------------------------------------------------------------- CAPI

  private buildCapiBranch(
    input: QueryInput,
    host: HostDef,
    env: EnvironmentDef,
    agency: string,
    warnings: string[]
  ): string {
    if (!input.applications.includes('CAPI')) return '';

    const parts = [
      'service:capi',
      // Exact value, not *ENV*. The legacy wildcard also matched NONPROD1-4,
      // AUPROD and PRODCA, so every CAPI production search was contaminated.
      `@Properties.log.EnvName:${env.capiEnvName}`,
      `@Properties.log.Agency:*${agency.toUpperCase()}*`,
    ];

    // Region comes from the cluster's env: tag, not from EnvName -- the AU
    // cluster emits PROD, NONPROD1, NONPROD2, STAGE, SUPP and TEST alongside
    // AUPROD, so EnvName on its own cannot separate the regions.
    if (host.capiRegionClause) parts.push(host.capiRegionClause);
    if (host.capiRegionNote) warnings.push(host.capiRegionNote);

    return `(${parts.join(' AND ')})`;
  }

  // ---------------------------------------------------- containerised services

  /**
   * One sub-branch per service target, OR'd together.
   *
   * A single shared branch is not expressible. The selected services do not
   * agree on either scope:
   *
   *   - Environment lives on a different tag per family. `env:civp_prod_azure`
   *     is right for ACDS and returns nothing for payment-adapter-service,
   *     where the value is a bare `prod`.
   *   - Some targets carry no agency field at all. AND-ing the agency scope
   *     across the whole branch silently excluded every event-log-service, ADS
   *     and ConfigStore line -- the query looked correct and returned a subset.
   *
   * So each target contributes `(identity AND env? AND agency?)` on its own
   * terms, and anything that cannot be scoped says so in a warning instead of
   * emitting a clause that matches nothing.
   */
  private buildServiceBranch(
    services: ServiceDef[],
    env: EnvironmentDef,
    agency: string,
    warnings: string[]
  ): string {
    if (!services.length) return '';

    const lower = agency.toLowerCase();
    const seen = new Set<string>();
    const branches: string[] = [];
    const unscopedByEnv: string[] = [];
    const notes = new Set<string>();

    for (const target of services.flatMap((s) => s.targets)) {
      // The same target object appears under several services (event-log-service
      // is shared by all three payment providers), so dedupe on identity.
      const key = `${target.field}:${target.values.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const branch = this.buildTargetBranch(target, env, agency, lower, unscopedByEnv);
      if (branch) branches.push(branch);
      if (target.note) notes.add(target.note);
    }

    if (unscopedByEnv.length) {
      warnings.push(
        `No environment tag is known for ${this.listPhrase(unscopedByEnv)} in ${env.ui}, so those logs are returned across all environments. See the ASSUMPTION comments in environments.config.ts.`
      );
    }
    for (const note of notes) warnings.push(note);

    if (!branches.length) return '';
    return branches.length > 1 ? `(${branches.join(' OR ')})` : branches[0];
  }

  private buildTargetBranch(
    target: ServiceTarget,
    env: EnvironmentDef,
    agency: string,
    agencyLower: string,
    unscopedByEnv: string[]
  ): string {
    // service:(a OR b) rather than service:a OR service:b -- the grouped form
    // is Datadog's documented pattern for multiple values of one field.
    const identity =
      target.values.length > 1
        ? `${target.field}:(${target.values.join(' OR ')})`
        : `${target.field}:${target.values[0]}`;

    const clauses = [identity];

    const envClause = target.envClause(env, agencyLower);
    if (envClause) {
      clauses.push(envClause);
    } else if (!target.note) {
      // A target with its own note already explains why it cannot be scoped;
      // adding the generic warning too just says the same thing twice.
      unscopedByEnv.push(target.values.join(', ').replace(/"/g, ''));
    }

    if (target.agencyScope === 'attributes') {
      clauses.push(this.agencyScopeForServices(agency));
    } else if (target.agencyScope === 'freetext') {
      // The agency is inside an unparsed message body, so there is no facet to
      // filter on. Free-text matching is case insensitive -- unlike facets --
      // so a single casing is enough here.
      clauses.push(`*${agency.toUpperCase()}*`);
    }

    return clauses.length > 1 ? `(${clauses.join(' AND ')})` : clauses[0];
  }

  private listPhrase(items: string[]): string {
    if (items.length === 1) return items[0];
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  /**
   * Which agency field is populated varies by service, so all of them are OR'd
   * rather than betting on one.
   *
   * @SERV_PROV_CODE is included in both casings. It was originally left out on
   * the assumption that containerised services do not carry it; a working
   * payment-adapter-service query confirmed they do, and that facet values are
   * case sensitive, so both are needed.
   */
  private agencyScopeForServices(agency: string): string {
    const upper = agency.toUpperCase();
    const lower = agency.toLowerCase();
    return (
      `(@agencycode:${upper}` +
      ` OR @Agency:*${upper}*` +
      ` OR @Properties.log.Agency:*${upper}*` +
      ` OR @usr.agency:*${upper}*` +
      ` OR @SERV_PROV_CODE:*${lower}*` +
      ` OR @SERV_PROV_CODE:*${upper}*)`
    );
  }

  // ----------------------------------------------------------------- selection

  private resolveServices(selected: string[], errors: string[]): ServiceDef[] {
    const defs = selected
      .map((ui) => ADDITIONAL_SERVICES.find((s) => s.ui === ui))
      .filter((s): s is ServiceDef => !!s);

    for (const category of ['payment', 'document'] as const) {
      const inCategory = defs.filter((d) => d.category === category);
      if (inCategory.length > 1) {
        errors.push(
          `Select only one ${category} service (${inCategory.map((d) => d.ui).join(', ')} are all selected).`
        );
      }
    }

    return defs;
  }

  // -------------------------------------------------------- additional params

  /**
   * Tokenise additional parameters, joining with AND.
   *
   * Two changes from legacy. Terms are AND'd, so adding a term narrows the
   * search as users expect, rather than widening it. And the tokeniser handles
   * a single quoted word: legacy checked startsWith('"') before
   * endsWith('"') in an else-if chain, so `"foo"` opened a quote that never
   * closed and the term was silently discarded.
   */
  formatAdditionalParams(raw: string): string {
    const text = raw.trim();
    if (!text) return '';

    const terms: string[] = [];
    // Quoted phrases stay intact; everything else splits on whitespace.
    const pattern = /"([^"]*)"|(\S+)/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      if (match[1] !== undefined) {
        const phrase = match[1].trim();
        // Wildcards do not work inside quotes, so a quoted phrase is passed
        // through verbatim.
        if (phrase) terms.push(`"${phrase}"`);
      } else if (match[2]) {
        const term = match[2];
        // Already a field filter or negation -- pass through untouched rather
        // than wrapping it in wildcards and breaking it.
        terms.push(this.looksLikeFilter(term) ? term : `*${term}*`);
      }
    }

    if (!terms.length) return '';
    return terms.length > 1 ? `(${terms.join(' AND ')})` : `(${terms[0]})`;
  }

  private looksLikeFilter(term: string): boolean {
    return term.includes(':') || term.startsWith('-');
  }
}
