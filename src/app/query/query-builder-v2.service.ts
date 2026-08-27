import { Injectable } from '@angular/core';
import {
  ADDITIONAL_SERVICES,
  EnvironmentDef,
  findEnvironment,
  findHost,
  HostDef,
  ServiceDef,
} from './environments.config';
import { QueryEngine, QueryInput, QueryResult } from './query-input.model';

/**
 * Whether to add `env:<tag>` to the containerised-service branch.
 *
 * OFF, based on evidence. A payment-adapter-service query that works returns
 * nothing once `env:prod` is added, so either those logs carry no `env` tag or
 * its values are not the tokens in environments.config.ts. Without it, service
 * results are scoped to the agency but span environments -- far better than the
 * original defect, which spanned every tenant.
 *
 * To re-enable: confirm the real tag with
 *
 *   SELECT env, COUNT(*) FROM dd.logs(
 *     columns => ARRAY['env'], filter => 'service:payment-adapter-service',
 *     from_timestamp => NOW() - INTERVAL '7 day', to_timestamp => NOW())
 *     AS (env VARCHAR)
 *   GROUP BY env
 *
 * then set the matching `envTag` values and flip this to true.
 */
const SCOPE_SERVICES_BY_ENV = false;

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

    if (host.capiRegionClause) {
      parts.push(host.capiRegionClause);
    } else {
      warnings.push(
        `CAPI logs cannot yet be pinned to the ${host.ui} region, so results may include CAPI logs from other regions. Set capiRegionClause in environments.config.ts once the region tag value is confirmed.`
      );
    }

    return `(${parts.join(' AND ')})`;
  }

  // ---------------------------------------------------- containerised services

  private buildServiceBranch(
    services: ServiceDef[],
    env: EnvironmentDef,
    agency: string,
    warnings: string[]
  ): string {
    if (!services.length) return '';

    const serviceValues = [...new Set(services.flatMap((s) => s.services))];
    const nameValues = [...new Set(services.flatMap((s) => s.names ?? []))];

    // service:(a OR b) rather than service:a OR service:b -- the grouped form
    // is Datadog's documented pattern for multiple values of one field.
    const identity: string[] = [];
    if (serviceValues.length) identity.push(`service:(${serviceValues.join(' OR ')})`);
    if (nameValues.length) identity.push(`name:(${nameValues.join(' OR ')})`);

    // The core fix: the service branch is scoped by agency instead of being a
    // bare unqualified OR. Environment scoping is separate -- see below.
    const agencyScope = this.agencyScopeForServices(agency);
    const clauses = [`(${identity.join(' OR ')})`, agencyScope];

    if (SCOPE_SERVICES_BY_ENV) {
      clauses.splice(1, 0, `env:${env.envTag}`);
    } else {
      warnings.push(
        `Additional-service logs are scoped to ${agency.toUpperCase()} but not to ${env.ui}, so results may include other environments for this agency. Adding env: returned no results, so it is disabled until the real environment tag is identified.`
      );
    }

    for (const s of services) {
      if (s.note) warnings.push(s.note);
    }

    return `(${clauses.join(' AND ')})`;
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
