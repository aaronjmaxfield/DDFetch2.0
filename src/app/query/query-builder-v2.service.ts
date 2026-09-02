import { Injectable } from '@angular/core';
import {
  ADDITIONAL_SERVICES,
  EnvironmentDef,
  findEnvironment,
  findHost,
  HostDef,
  ServiceDef,
  ServiceTarget,
  acaUrlSegment,
  CAPI_SERVICES,
} from './environments.config';
import {
  activeScopeExtras,
  fieldsFor,
  findCategory,
  findOption,
  scopeSuppliesOwnLogs,
} from './scopes.config';
import {
  chronicExclusion,
  chronicKeptSummary,
  chronicSummary,
  routineChatterExclusion,
} from './noise.config';
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

    /*
     * A scoped selection contributes the same additional service the checkboxes
     * used to, so the service branch is reused rather than reimplemented. The
     * union is deliberate: the checkbox path still works, which is what keeps
     * this additive rather than a migration.
     */
    const scopeOption = findOption(input.scope?.category, input.scope?.option);
    const requestedServices = [...input.additionalServices];
    if (scopeOption?.serviceUi && !requestedServices.includes(scopeOption.serviceUi)) {
      requestedServices.push(scopeOption.serviceUi);
    }

    const services = this.resolveServices(requestedServices, errors);
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
      /*
       * Scope-aware, because the generic form sent people looking at the
       * checkboxes when the actual problem was the scope they had picked. A
       * filter-only scope needs a tier to filter; a service-bearing one does
       * not. See `scopeSuppliesOwnLogs`.
       */
      const scopeLabel = findCategory(input.scope?.category)?.label;
      errors.push(
        scopeLabel && !scopeSuppliesOwnLogs(input.scope?.category, input.scope?.option)
          ? `The ${scopeLabel} scope narrows a search rather than being a log source of its own, so it needs somewhere to look. Select Civic Platform, Citizen Access or Construct API as well.`
          : 'Select at least one application or additional service.'
      );
      return { query: '', warnings, errors };
    }

    /*
     * Service-only searches are legitimate -- looking at payment-adapter-service
     * on its own is how you read the adapter conversation without the tiers
     * either side of it -- but they are narrow enough that saying so is worth
     * the line. Same principle as the Citizen-Access-only advisory: the engine
     * states what it left out rather than quietly adding it back.
     */
    if (!input.applications.length && services.length) {
      warnings.push(
        `Only ${services.map((s) => s.ui).join(' and ')} logs are included -- no Civic Platform, Citizen Access or Construct API. That is a deliberately narrow view: if the answer is not here, tick Civic Platform and run it again.`
      );
    }

    let query = branches.length > 1 ? `(${branches.join(' OR ')})` : branches[0];

    /*
     * -------------------------------------------------------------------------
     * RAW MODE
     * -------------------------------------------------------------------------
     * Every narrowing clause below is skipped. See QueryInput.rawMode for what
     * that includes and what it deliberately leaves alone.
     *
     * Worth having because every one of those clauses is a judgement call made
     * from a measurement, and a measurement generalises until it does not. The
     * document investigation is the standing example: the marker set was right
     * about volume and wrong about the record ID, and the only way to see that
     * was to look at the unfiltered stream.
     */
    const raw = input.rawMode === true;

    /*
     * Scoped clauses narrow the whole query rather than joining the OR, because
     * an identifier is a statement about which event you want, not about which
     * tier it came from. A CAP ID should cut across biz, ACA and the payment
     * adapter at once.
     */
    if (!raw) {
      for (const clause of this.buildScopeClauses(input, env, agency, warnings)) {
        query = `${query} AND ${clause}`;
      }
    }

    if (!raw && scopeOption?.providerUrn) {
      /*
       * `OR -@PROVIDER:*` is load-bearing. Only ~50% of payment-adapter lines
       * carry the attribute -- 11 of 20 on one measured transaction, 16 of 27 on
       * another -- so a bare AND would cut the trace in half. This form removed
       * exactly the other providers' lines and kept both Forte traces whole.
       */
      /*
       * An adapter can log under more than one provider id, so this takes a
       * list. SecurePay needs it: its ACA path currently tags itself
       * `epayments3`, and filtering on payrix alone deleted the ACA half.
       */
      const urns = Array.isArray(scopeOption.providerUrn)
        ? scopeOption.providerUrn
        : [scopeOption.providerUrn];
      const providerClause = urns.map((u) => `@PROVIDER:"${u}"`).join(' OR ');
      query = `${query} AND (${providerClause} OR -@PROVIDER:*)`;

      if (urns.length > 1) {
        warnings.push(
          `This adapter is logged under more than one provider id (${urns.join(', ')}), so all of them are included. For SecurePay that is deliberate: the Citizen Access path currently tags its lines with the wrong provider id, and filtering on the correct one alone hid the ACA side of the adapter.`
        );
      }
    }

    /*
     * A custom adapter has no service and no @PROVIDER value to filter on, so
     * the option supplies its own clause. See ScopeOption.extraClause.
     *
     * `OR -service:aca` is load-bearing and was missing in the first version.
     * The clause identifies the adapter by an ACA logger facet, so AND-ing it
     * raw forced `service:aca` onto the ENTIRE query and silently deleted the
     * biz tier -- a CLARKCO search returned ACA lines only. The payment is
     * applied in the biz tier, so that is half the story gone.
     *
     * Scoped this way it means "if this is an ACA line it must be one of these
     * loggers; otherwise let the branch's own scoping decide". Measured on
     * CLARKCO over 24h, the biz tier carries 2,702 `*payment*` lines, 1,509
     * `*transaction-id*`, 1,247 `*receipt*` and 22 `*F4PAYMENT*` -- and ZERO
     * lines naming CyberSource, its actual adapter. The biz tier records payment
     * activity with no adapter identity whatsoever, which is exactly why it
     * cannot be filtered by an adapter clause and must be scoped by the
     * category's markers instead.
     */
    if (!raw && scopeOption?.extraClause) {
      query = `${query} AND ((${scopeOption.extraClause}) OR -service:aca)`;
    }

    const params = this.formatAdditionalParams(input.additionalParams);
    if (params) query = `${query} AND ${params}`;

    /*
     * ------------------------------------------------------------------------
     * NOISE REDUCTION IS WHAT SCOPING BUYS YOU
     * ------------------------------------------------------------------------
     * Nothing is filtered out until the user says what they are investigating.
     * An unscoped search returns everything for the agency and environment, on
     * purpose, so that narrowing afterwards in Datadog -- by CAP ID, by
     * transaction ID, by a phrase from a ticket -- cannot silently miss a line
     * we removed first.
     *
     * That is not a theoretical risk. Measured on LEECO PROD over 24 hours,
     * 390,750 lines carry a 5-5-5 CAP ID, and 3,948 of them match
     * `"Request URL:https"` -- so the old always-on filter would have removed
     * them before the user ever typed the CAP ID. The Construct case is worse:
     * of 21,850,112 biz lines carrying `TraceId is`, zero survived the
     * response-size pattern, and that line is the one saying what the API
     * returned.
     *
     * Volume is the price. On that agency the unscoped result is 3,006,120
     * lines instead of 1,744,225. That is the right trade: Datadog can page
     * through three million lines, and a wrong conclusion drawn from a filtered
     * set cannot be undone.
     */
    const scopedCategory = findCategory(input.scope?.category);
    const isScoped = !!scopedCategory;

    // Unscoped defaults to no filtering, but an explicit `true` still forces it.
    // Raw mode outranks both, including an explicit `true` -- the whole promise
    // of the toggle is that nothing was removed.
    const filterChatter =
      !raw &&
      (isScoped ? input.hideRoutineChatter !== false : input.hideRoutineChatter === true);

    if (filterChatter) {
      // The selected scope may depend on a chatter pattern as evidence -- a
      // payment investigation needs the sequence-allocation lines that
      // `lSeqRemaining` otherwise removes.
      const { chatterExceptions } = activeScopeExtras(
        input.scope?.category,
        input.scope?.option,
        input.scope?.fields
      );
      const exclusion = routineChatterExclusion(chatterExceptions);
      if (exclusion) query = `${query} AND ${exclusion}`;
    }

    /*
     * Chronic conditions are real warnings, so hiding them is announced rather
     * than silent. On the busiest Forte agency the slow-report warning alone is
     * ~60,000 lines in 24 hours and 99.6% of everything left after scoping --
     * it buries the payment failures it sits next to. Also scope-gated: an
     * unscoped search is meant to be complete.
     */
    if (!raw && isScoped && input.showChronic !== true) {
      /*
       * A category whose whole subject IS the chronic pattern must keep it. The
       * reporting scope is the case: with the markers in place but the pattern
       * still hidden, the tool returned 1 warning for LEECO, 1 for FDNY and ZERO
       * for three other agencies, and three real tickets returned 0 rows, 0 rows
       * and 128 rows against 331, 857 and 12,985 once exempted.
       */
      const { chronicExceptions } = activeScopeExtras(
        input.scope?.category,
        input.scope?.option,
        input.scope?.fields
      );
      const exclusion = chronicExclusion(chronicExceptions);
      if (exclusion) {
        query = `${query} AND ${exclusion}`;
        // Summary takes the same exceptions, or the warning names things that
        // were not hidden -- which sends the user hunting for a toggle to
        // recover data already in front of them.
        warnings.push(
          `Hidden because they are constant in this environment rather than related to your search: ${chronicSummary(chronicExceptions)}. These are real warnings -- turn on "Show chronic warnings" to include them.`
        );
      }
      const kept = chronicKeptSummary(chronicExceptions);
      if (kept) {
        warnings.push(
          `Kept because this scope is about them: ${kept}. They are normally hidden as background noise.`
        );
      }
    }

    if (raw) {
      /*
       * Deliberately specific about the two things it did NOT do, because "raw"
       * invites the assumption that it did everything. Someone who concludes
       * "there are no EMSE lines" from a raw search would be wrong, and that is
       * exactly the kind of wrong conclusion the rest of this engine works to
       * prevent.
       */
      const parts = ['Raw mode: nothing has been filtered out.'];
      if (isScoped) {
        parts.push(
          `Your ${scopedCategory?.label} scope still decides WHERE to look, so the services it adds are included -- but none of its filters are applied, and any identifier you typed into its fields was ignored.`
        );
      }
      parts.push(
        'Script engine logs and ACA page requests are separate sources rather than filters, so they are still controlled by their own tick-boxes above and are NOT included unless you ticked them.'
      );
      warnings.push(parts.join(' '));
    } else if (!isScoped) {
      warnings.push(
        'Nothing has been filtered out. This is everything logged for this agency and environment, which is deliberate -- narrow it down in Datadog and you can be certain nothing was removed before you looked. Once you know what you are investigating, pick a Scope to cut the routine noise.'
      );
    }

    return { query, warnings, errors };
  }

  /**
   * Clauses for the filled-in scope fields.
   *
   * ---------------------------------------------------------------------------
   * ALTERNATIVES ARE OR-ED, FILTERS ARE AND-ED
   * ---------------------------------------------------------------------------
   * Most of these fields are alternative handles for one thing. A CAP ID, a
   * document id, a file name and a file key are four ways of naming the same
   * document, and no single log line carries all four -- so AND-ing them means
   * one value that happens not to be logged zeroes the whole result.
   *
   * That is not hypothetical. A document search combining a file name with a
   * file key returned nothing, because the file name was never recorded for that
   * upload: `*Doc1.pdf*` is zero estate-wide. AND-ing made an unlogged value
   * destroy two good ones.
   *
   * So they are OR-ed, which gives the union of what each finds and cannot be
   * zeroed by one bad value. Fields that are genuinely narrowing attributes
   * rather than names -- a record type, a map service, a scheduled date -- set
   * `filter: true` and are still AND-ed.
   */
  private buildScopeClauses(
    input: QueryInput,
    env: EnvironmentDef,
    agency: string,
    warnings: string[]
  ): string[] {
    const values = input.scope?.fields;
    if (!values) return [];

    const ctx = {
      agencyUpper: agency.toUpperCase(),
      agencyLower: agency.toLowerCase(),
      env,
    };

    const alternatives: string[] = [];
    const filters: string[] = [];
    const altLabels: string[] = [];

    for (const field of fieldsFor(input.scope?.category, input.scope?.option)) {
      const raw = values[field.id];
      if (!raw || !raw.trim()) continue;

      const warning = field.warn?.(raw);
      if (warning) warnings.push(warning);

      const clause = field.clause(raw, ctx);
      if (!clause) continue;

      if (field.filter) {
        filters.push(clause);
      } else {
        alternatives.push(clause);
        altLabels.push(field.label);
      }
    }

    const out: string[] = [];
    if (alternatives.length === 1) {
      out.push(alternatives[0]);
    } else if (alternatives.length > 1) {
      out.push(`(${alternatives.join(' OR ')})`);
      // Said out loud, because a union is not what "two boxes filled in" looks
      // like it should do, and a silent union would be its own trap.
      warnings.push(
        `${altLabels.join(' and ')} are treated as alternatives, so you get lines matching ANY of them rather than only lines matching all. That is deliberate: they are different names for the same thing and no single log line carries them all, so requiring all of them would return nothing.`
      );
    }
    out.push(...filters);
    return out;
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

    /*
     * -------------------------------------------------------------------------
     * "CITIZEN ACCESS" ALONE NOW MEANS CITIZEN ACCESS ALONE. Corrected 2026-09-02.
     * -------------------------------------------------------------------------
     * This used to read `includes('Civic Platform') || wantsAca`, on the
     * reasoning that ACA is the front end and Civic Platform the back end, so an
     * ACA search "always needs the biz tier too". That reasoning is sound as
     * ADVICE and wrong as BEHAVIOUR: it made the checkbox silently select a tier
     * the user had deliberately left unticked.
     *
     * Reported as "the ACA only box is also pulling biz and indexer logs", and
     * measured on a 20-minute CRC-TEST window with only Citizen Access ticked:
     *
     *     av.biz      67
     *     av.indexer  54
     *     av.web      19
     *     aca         18   <-- the only lines that were asked for
     *     av.cfmx      1
     *
     * 18 of 159 lines, so 89% of the result set was the tier the box did not
     * select, and the indexer got in because its exclusion is scope-gated. The
     * ACA arms in isolation return exactly those 18 and nothing else.
     *
     * The domain fact survives as a warning below rather than as a hidden OR.
     * Widening a search without saying so is the same failure as narrowing one
     * without saying so, which this engine already refuses to do.
     */
    const wantsBiz = input.applications.includes('Civic Platform');
    if (!wantsBiz && !wantsAca) return '';

    const upper = agency.toUpperCase();
    const lower = agency.toLowerCase();
    const identity: string[] = [];

    if (!wantsBiz) {
      /*
       * Citizen Access only. Every arm below identifies a BIZ-tier line, so all
       * of them are skipped -- including the ones that look tier-neutral.
       * @JNDI and @SERV_PROV_CODE are exactly how the indexer, av.web and
       * av.cfmx lines got in: they are agency-tagged too.
       */
    } else if (host.usesJndi && !env.jndiDead) {
      // Facet values are case sensitive, so both casings are needed. Real values
      // are {lower}-{lower} or {UPPER}-{UPPER}; no mixed pair was observed.
      identity.push(`@JNDI:*${lower}-${env.jndi}*`, `@JNDI:*${upper}-${env.jndi.toUpperCase()}*`);

      /*
       * @SERV_PROV_CODE is a FALLBACK here, not a peer of @JNDI, and that
       * subordination is the single largest noise fix in this engine.
       *
       * As a peer it defeated the environment selection outright. Six US rows
       * share `host:*mtsup*` and @JNDI is the only thing that separates them, so
       * OR-ing in an environment-free @SERV_PROV_CODE clause put every
       * neighbouring environment back in. Measured on a real agency at US SUPP:
       * 64% of the result set was TEST logs, and switching NONPROD1 to NONPROD3
       * changed the total by under 1%.
       *
       * It also caused cross-tenant bleed: the trailing wildcard means a
       * two-character agency code is a mid-token substring of at least ten
       * longer, unrelated codes, and 20% of that agency's results were other
       * tenants'.
       *
       * Nothing is lost by demoting it. On US PROD, @SERV_PROV_CODE present
       * while @JNDI is absent is 9,661 lines/day out of 135M estate-wide, and
       * exactly 0 for a given agency -- so the `-@JNDI:*` guard keeps the whole
       * population the arm was there for.
       */
      identity.push(`(@SERV_PROV_CODE:*${upper}* AND -@JNDI:*)`);
      identity.push(`(@SERV_PROV_CODE:*${lower}* AND -@JNDI:*)`);

      /*
       * -----------------------------------------------------------------------
       * BIZ LINES THAT NAME THE AGENCY BUT CARRY NO AGENCY FACET.
       * Added 2026-09-02 after a real SANTAANA failure whose ROOT CAUSE was
       * unreachable at every setting.
       * -----------------------------------------------------------------------
       * The symptom was `AccelaAdapter webhook not recieved`. The cause was an
       * EMSE script: `**ERROR** "capAltId" is not defined. In PRA:*{/}*{/}*{/}*
       * Line 3`, inside a PaymentReceiveAfter dump. Every arm above missed it,
       * because that line carries NEITHER @JNDI NOR @SERV_PROV_CODE -- measured
       * on the 5-minute window, `@JNDI:*santaana-nonprod1*` is 0 against it and
       * `@SERV_PROV_CODE:*SANTAANA*` is 0, while 7 of the 12 estate-wide
       * `PaymentReceiveAfter Script Error` lines in that window had no agency
       * facet of any kind.
       *
       * It DOES name the agency in its body, as a CAP ID: `record ID:
       * SANTAANA-PWK26-00000`. So a free-text arm reaches it, and the existing
       * free-text arm could not: that one is `service:aca AND *{AGENCY}*`, and
       * this is a biz line.
       *
       * ANCHORED ON `{AGENCY}-`, which is the whole reason this is affordable.
       * The bare `*{AGENCY}*` form repeats the emse.log mistake from earlier the
       * same day -- a short code matches incidental text. Measured over 24h with
       * the payment markers applied:
       *
       *              bare *AGENCY*   anchored *AGENCY-*
       *   SANTAANA              13                   13
       *   LEECO              7,735                7,727
       *   CRC               12,032                    9
       *   COSA              10,538               10,340
       *
       * CRC drops by 99.93% and SANTAANA loses nothing, because a CAP ID always
       * has the hyphen and `x-ms-content-crc64` does not.
       *
       * Gated on BOTH facets being absent, so it is disjoint from the arms above
       * by construction and cannot double-count. Cost unscoped is real -- 397
       * lines/24h on SANTAANA, 182,016 on LEECO -- and is accepted on the same
       * basis as the rest of the unscoped promise: 182k against LEECO's existing
       * ~3M is 6%, and the alternative is a root cause that cannot be found.
       *
       * KNOWN RESIDUAL: a code that is a substring of a longer agency's code
       * still leaks, since free text cannot anchor at a token start. Measured on
       * the worst case to hand, `*SEATTLE-*` returns 17,654 lines of which 180
       * also match `*PORTSEATTLE-*` -- about 1%. Same tradeoff the
       * `@SERV_PROV_CODE:*{UPPER}*` arms already make.
       *
       * Do NOT try to narrow this by status. The line that mattered is
       * `status:info` despite containing the word ERROR, and the whole arm holds
       * zero error-status lines on both agencies measured.
       */
      identity.push(
        `(service:av.biz AND *${upper}-* AND -@JNDI:* AND -@SERV_PROV_CODE:*)`
      );
    } else {
      // Oregon has no @JNDI at all -- every value is EMPTY -- so the agency
      // attribute is the only identity available and stands on its own. Both
      // casings: values are overwhelmingly uppercase but not exclusively, and
      // the biz branch used to emit only the upper form while the service
      // branch emitted both.
      identity.push(`@SERV_PROV_CODE:*${upper}*`, `@SERV_PROV_CODE:*${lower}*`);

      if (host.usesJndi && env.jndiDead) {
        warnings.push(
          `No @JNDI environment exists for ${host.ui} ${env.ui} -- the token matches nothing in the log estate -- so results cannot be pinned to this environment and may include neighbouring ones.`
        );
      }
    }

    /*
     * The EMSE log carries NEITHER @SERV_PROV_CODE nor @JNDI, anywhere, in any
     * environment, so without an arm of its own the whole of emse.log is
     * invisible -- 14.9% of US PROD av.biz.
     *
     * But it is bulk. Measured on one agency at US SUPP over 6h it is 7,525
     * lines, all `status:info`, against 1,052 for the rest of the biz branch
     * combined. Including it unconditionally more than undid the noise work
     * above, so it is off by default and on where it is the ONLY thing there.
     *
     * On Oregon PROD emse.log is the sole av.biz file -- `host:*orprd*
     * service:av.biz @SERV_PROV_CODE:*` is 0 -- so without it a Civic Platform
     * search returned index-builder lines and nothing else. Oregon STG is 46%
     * emse. Those rows opt in via `emseIsPrimaryBizLog`.
     *
     * ---------------------------------------------------------------------
     * EMSE.LOG CANNOT BE SCOPED BY AGENCY. Corrected 2026-09-02.
     * ---------------------------------------------------------------------
     * This arm used to be `(filename:emse.log AND *{AGENCY}*)`, and for a short
     * agency code it returned almost entirely OTHER agencies' lines. Reported
     * as "the biz logic is pulling all agencies", and it was: on a 30-minute
     * CRC-TEST search, 891 of 992 lines came from this arm and the samples were
     * MISSOULA, COSA, SACRAMENTO and PRESCOTTVLY.
     *
     * The cause is a substring collision with an Azure Storage response header
     * that every event-log upload line carries:
     *
     *     x-ms-content-crc64:pcF0LOEplLE=
     *
     * Free text is case-insensitive, so `*CRC*` matches `crc64`. It is not
     * specific to CRC -- measured on the same window, `*ID*` matched 46,962
     * lines (`x-ms-request-id`), `*ES*` 30,204, `*DC*` 3,193, `*MD*` 2,114. Any
     * short agency code leaks catastrophically.
     *
     * Every alternative was measured and none works:
     *   - No facet exists. Grouping emse.log by @SERV_PROV_CODE, @JNDI,
     *     @agencycode and @Agency all return ZERO buckets, and a raw event has
     *     those attributes empty. Free text is the only route.
     *   - Punctuation is ignored, so `*CRC.*` is identical to `*CRC*` (891 both).
     *   - The exact-token form under-matches by 800x: `*OSCEOLA*` is 9,640 and
     *     `"OSCEOLA"` is 12. And `"ID"` still leaks 1,048.
     *   - A phrase anchor on the line's own wording returns nothing:
     *     `"by OSCEOLA"` is 0 against 9,640.
     *
     * So the clause is now anchored on the one shape that is both present and
     * unambiguous -- the `{agency}-{jndi}` token in the event-log blob names,
     * verified pure (12 of 12 sampled lines for one agency, 0 belonging to
     * another). That is a minority of emse.log, so the loss is announced rather
     * than hidden: script-content lines identify their agency only as
     * `{AGENCY}.{USER}` inside free text, which cannot be distinguished from a
     * substring collision, and the honest way to reach them is a script name or
     * a trace ID.
     *
     * This also corrects the "+1.0% to +40.0% lines and zero errors" figure
     * recorded for `forceEmse`: much of what that arm was adding was other
     * agencies' lines.
     */
    const forceEmse = findCategory(input.scope?.category)?.forceEmse === true;
    // emse.log is a biz-tier file, so it follows the tier and not the toggle.
    // Announcing an EMSE decision on a Citizen-Access-only search would be
    // describing a tier that is not in the query.
    if (!wantsBiz) {
      /* Not in scope. */
    } else if (input.includeEmse || env.emseIsPrimaryBizLog || forceEmse) {
      identity.push(`(filename:emse.log AND *${lower}-${env.jndi}*)`);
      warnings.push(
        'Script engine logs (emse.log) carry no agency field of any kind, so they cannot be filtered by agency. Only the lines that name this agency are included: the event-log uploads, plus any script output that mentions one of this agency\'s record IDs -- which is where a failing script names itself. A script error that mentions no record ID is still out of reach; for those, search filename:emse.log with your script name or trace ID directly in Datadog.'
      );
    } else {
      warnings.push(
        'EMSE script logs are excluded: they carry neither @SERV_PROV_CODE nor @JNDI, so they need a free-text arm, and they are high-volume and info-only. Enable "Include EMSE" if you are chasing script behaviour.'
      );
    }

    if (wantsAca) {
      if (env.acaFilename) {
        /*
         * Anchored, not `*token*`. Every ACA log filename starts with the agency
         * code, so the leading wildcard bought no recall and leaked other
         * tenants: `*seattle-supp*` returned 7,811 lines that were all
         * `portseattle-supp`, and `*port-prod*` matched northport, westport and
         * sfport. Anchoring is byte-identical on the codes that were already
         * unambiguous. `filename` is case sensitive and must be lowercase.
         */
        const acaToken = env.acaFilename(lower);
        identity.push(`filename:${acaToken}*`);

        /*
         * These two are environment-agnostic on their own, and where a host
         * clause is shared between rows they defeated the environment selection
         * the same way the old @SERV_PROV_CODE peer did -- a US NONPROD1 search
         * returned 7.5x the intended population. Constraining both to the
         * environment's own filename shape fixes that without losing recall.
         *
         * The free-text arm earns its place despite the noise: it is the only
         * route to Oregon child agencies, whose ACA filenames are site names
         * rather than agency codes.
         *
         * It does NOT reach the IIS access logs. This comment used to claim it
         * was "the only route" to them, which was wrong and hid the largest
         * blind spot in the tool: both arms are gated on a `filename:` shape,
         * and the IIS logs are written to `u_ex{date}_x.log`, so
         * `filename:u_ex*` AND `filename:*-prod*` is 0 by construction. They are
         * reachable only via the URL path -- see the `includeIis` arm below.
         *
         * The shape is derived from the filename token, NOT from `env.jndi`.
         * They diverge: Oregon TRAIN's jndi is `ortest` but its file is
         * `oregon-oregon-train-aca`, and Oregon CONFIG's is `orconf` against
         * `{agency}-oregon-config-aca`. Keying off jndi would have silently
         * broken both.
         */
        const envShape = acaToken.startsWith(`${lower}-`)
          ? `filename:*${acaToken.slice(lower.length)}*`
          : `filename:${acaToken}*`;
        identity.push(`(service:aca AND @agencycode:${upper} AND ${envShape})`);
        identity.push(`(service:aca AND *${upper}* AND ${envShape})`);

        /*
         * Page requests. Opt-in, because this population is enormous: LEECO
         * alone is 1,891,225 IIS lines in 24 hours, which would bury everything
         * else in a default search. Under the payment scope the category markers
         * cut that to 16,766, and only 1,172 of those are non-200 -- so it is
         * usable when asked for and ruinous when not.
         *
         * Worth having because it is the only place the HTTP status and the page
         * duration live. In one real case the evidence that a payment page took
         * 121 seconds and returned a 302 existed ONLY on an IIS line, and the
         * tool could not return it at any setting.
         */
        if (input.includeIis) {
          identity.push(
            `(service:aca AND filename:u_ex* AND ${acaUrlSegment(upper, env)})`
          );
          /*
           * Announced, because the counts mislead. Adding these took a measured
           * LEECO payment search from 37,226 lines to 53,960 while the error
           * count stayed at 136: Datadog classes every IIS line as `info`
           * regardless of the HTTP status it records, so a page that returned
           * 500 does not appear as an error. Someone filtering on error status
           * would conclude the page was fine.
           */
          warnings.push(
            'Page requests are included. Note that these lines are all logged as "info" even when the page failed -- the HTTP status is inside the message text, so filtering by error status will hide a 500. Look for the status code near the end of the line, along with the time taken in milliseconds.'
          );
        }
      } else {
        warnings.push(
          env.acaNote ??
            `Citizen Access logs are not collected for ${host.ui} ${env.ui}, so the ACA filter was left out.` +
              (wantsBiz
                ? ' Only Civic Platform logs will be returned.'
                : ' Citizen Access is the only application selected, so this search has nothing to return -- tick Civic Platform as well.')
        );
      }
    }

    /*
     * Nothing to identify with. Only reachable when Citizen Access is the sole
     * selection on a row that collects no ACA logs, and the warning above has
     * already said so. Returning an empty branch is essential rather than tidy:
     * `(() AND host:*x*)` would match the entire host.
     */
    if (!identity.length) return '';

    /*
     * The advice that used to be enforced silently. Keeping it as a warning is
     * the point of the change: most of what ACA shows a citizen as a failure is
     * raised in the biz tier, and an ACA-only search cannot see the cause.
     *
     * The SANTAANA case is the clean example -- ACA logged `AccelaAdapter webhook
     * not recieved`, and the evidence that the webhook HAD arrived, two minutes
     * earlier, was on a biz-tier line.
     */
    if (wantsAca && !wantsBiz) {
      warnings.push(
        'Only Citizen Access logs are included. ACA is the front end, so the cause of a citizen-facing failure is usually logged in Civic Platform rather than here -- tick Civic Platform as well if the ACA lines do not explain it.'
      );
    }

    /*
     * The search indexer is excluded by default.
     *
     * It is agency-tagged, so it passes the identity filter and lands in every
     * biz-tier search -- and it dominates them. On a real AA PayPal payment
     * investigation it was 2,445 of 4,285 returned lines, 57% of the result set,
     * and it cannot contain the answer: every one of those lines was
     * `status:info`, with zero warns and zero errors in the window.
     *
     * Excluded rather than removed, because a search or indexing investigation
     * genuinely wants it -- see `includeIndexer` on QueryInput.
     */
    const scopeParts = [env.hostClause];

    /*
     * Restrict the biz tier to the chosen category. This is the largest single
     * reduction the engine makes -- see the bizMarkers note in scopes.config.ts
     * for the measurements. Without it, picking "Payment" added a payment
     * service branch and left the entire biz tier wide open, so a busy
     * production tenant returned over two million lines of which 74 errors
     * were actually about payments.
     *
     * Markers are wildcard form deliberately; quoted phrases under-match on
     * these logs. Note this is a POSITIVE clause, where wildcards are the
     * dependable shape -- the opposite rule applies to the exclusions.
     */
    const category = findCategory(input.scope?.category);

    /*
     * Also scope-gated. The indexer is a whole service, not chatter, and
     * dropping it unscoped would contradict the promise that an unscoped search
     * is complete -- it is 129,600 lines and 20 errors a day on LEECO.
     */
    /*
     * A field can ask to keep the indexer. The document-name field does: the
     * indexer holds 134,280 of the 152,909 lines a day that actually name a
     * document, so excluding it made a name search fight the scope it ran under.
     */
    const fieldWantsIndexer = activeScopeExtras(
      input.scope?.category,
      input.scope?.option,
      input.scope?.fields
    ).keepIndexer;
    // Biz-tier only: the indexer is agency-tagged, so it arrives through the
    // @JNDI arms. With those gone it cannot match, and excluding a service that
    // is already unreachable would just add a term to the query for show.
    if (
      wantsBiz &&
      input.rawMode !== true &&
      category &&
      !input.includeIndexer &&
      !fieldWantsIndexer &&
      !category.keepIndexer
    ) {
      scopeParts.push('-service:av.indexer');
    }

    /*
     * An option carrying its own `extraClause` scopes the ACA tier precisely, by
     * facet, so the category's crude free-text markers can only subtract there.
     *
     * Measured on MILARA over 24h: the custom-adapter clause returns 20,144
     * lines and 720 errors, and layering the payment markers on top took it to
     * 10,988 lines and **8 errors**. The markers removed 712 real errors because
     * ACA error messages frequently carry no payment word -- the same failure
     * that hid `AccelaAdapter webhook not recieved` in production.
     *
     * But the markers must still apply to the BIZ tier, which has no adapter
     * identity to filter on (CLARKCO logs zero CyberSource lines while running
     * CyberSource). So the markers are exempted for ACA lines only, rather than
     * dropped altogether -- dropping them entirely would leave the biz tier
     * completely unscoped and return millions of unrelated lines.
     */
    const preciseOption = findOption(input.scope?.category, input.scope?.option);
    const acaScopedByOption = !!preciseOption?.extraClause;

    /*
     * Also biz-tier only, and this one matters. The markers exist to scope a
     * tier that has no other handle; applied to ACA lines they DELETE ERRORS --
     * measured at 720 down to 8 on MILARA, because ACA error text frequently
     * carries no payment word. With no biz tier present there is nothing left
     * for them to narrow, so they could only do that damage.
     */
    if (
      wantsBiz &&
      input.rawMode !== true &&
      category?.bizMarkers?.length &&
      input.scopeBizTier !== false
    ) {
      /*
       * Fields that currently hold a value can add markers of their own. That is
       * how the Construct trace ID reaches the biz-tier response line: 21.8M
       * lines a day, unaffordable as a category marker, free once a trace ID has
       * narrowed the search to one request.
       */
      const extra = activeScopeExtras(
        input.scope?.category,
        input.scope?.option,
        input.scope?.fields
      ).bizMarkers;
      const markers = [...category.bizMarkers, ...extra];
      const markerClause = `(${markers.join(' OR ')})`;
      scopeParts.push(
        acaScopedByOption ? `(${markerClause} OR service:aca)` : markerClause
      );
      warnings.push(
        `The Civic Platform results are limited to ${category.label.toLowerCase()}-related lines. Clear the Scope dropdown to see the whole tier.`
      );
    }

    return `((${identity.join(' OR ')}) AND ${scopeParts.join(' AND ')})`;
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

    const upper = agency.toUpperCase();

    const parts = [
      /*
       * Construct is a family of seven services, not one, and `service:capi`
       * alone missed the most valuable member. Measured over 7 days: capi
       * 193,111,731, coauth 29,425,993, cdocapi 5,845,988, cadmin 136,071,
       * cuser 62,620, cdeveloper 2,287.
       *
       * `coauth` is Construct's auth service and carries exactly the tickets a
       * frontline user brings -- locked-out accounts, expired tokens, bad
       * credentials, invalid signature -- at 766,127 errors a week, 46% of all
       * Construct error volume. It is also the best-attributed service in the
       * family: 80% of its error lines carry the agency facet against 3.9% on
       * capi.
       *
       * `gateway` is deliberately excluded: 8,952 lines, staging only, and
       * entirely `status:debug`.
       */
      `service:(${CAPI_SERVICES.join(' OR ')})`,
      /*
       * MATCH-OR-ABSENT, and this is the single largest correction in the file.
       *
       * Both of these used to be hard ANDs, which silently discarded almost
       * every Construct error. CAPI logs errors from the response path with
       * `Agency: null, AppId: null, EnvName: null, UserName: null`, so the
       * attributes the clause required are simply not there. Measured over 7
       * days on `service:capi status:error`: 858,957 lines, of which 4,857
       * carry EnvName (0.57%) and 33,315 carry Agency (3.88%).
       *
       * Errors and warns over 7 days, old clause against this one:
       *
       *   ARLINGTONCO      0 / 0      ->  121,551 / 76,527
       *   LEECO            0 / 0      ->      660 / 155,442
       *   FDNY           498 / 9      ->   24,750 / 6,704
       *   MECKLENBURG     22 / 8      ->    1,332 / 9,106
       *
       * Two of those four reported NO Construct errors at all.
       */
      `(@Properties.log.EnvName:${env.capiEnvName} OR -@Properties.log.EnvName:*)`,
      /*
       * Front-anchored, plus the AZ sibling, plus a free-text fallback for the
       * unattributed lines.
       *
       * The old `*{AGENCY}*` was both too broad and too narrow. For agency `DC`
       * it matched seven tenants over 7 days -- DC 6,683,059, AZDC 2,847,783,
       * OAKLANDCO 270,388, AZMERCEDCO 33,330, LADCR 2,014, LOVELANDCO 1,403,
       * MERCEDCO 3 -- while still missing every line where the attribute is
       * absent. Anchoring keeps DC and AZDC and drops the other five.
       *
       * Front-anchoring is lossless for the real sibling shapes, which are
       * suffixes: `{AGENCY}-TEST` and `{AGENCY}_MOBILE` still match.
       *
       * The AZ prefix being the same tenant is a HYPOTHESIS, not measured. Drop
       * that arm if it turns out otherwise.
       */
      `(@Properties.log.Agency:(${upper}* OR AZ${upper}*) OR (-@Properties.log.Agency:* AND *${upper}*))`,
    ];

    // Region comes from the cluster's env: tag, not from EnvName -- the AU
    // cluster emits PROD, NONPROD1, NONPROD2, STAGE, SUPP and TEST alongside
    // AUPROD, so EnvName on its own cannot separate the regions.
    if (host.capiRegionClause) parts.push(host.capiRegionClause);
    if (host.capiRegionNote) warnings.push(host.capiRegionNote);

    /*
     * Said out loud, because the match-or-absent form has a real cost and the
     * user cannot see it. An unattributed Construct error names no environment
     * anywhere in the event, so keeping those lines necessarily keeps them for
     * every environment this tenant has.
     */
    warnings.push(
      'Construct error lines usually record no agency and no environment -- CAPI logs them with those fields null. To avoid hiding them the query keeps unattributed lines, which means some Construct results may come from this tenant\'s other environments. The Request half of each pair is where the URL and body are, so check those to confirm.'
    );

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

    if (target.agencyClause) {
      // The target's agency data is not uniform across its own environments, so
      // it supplies the whole clause rather than choosing between the shapes
      // below. See ServiceTarget.agencyClause.
      clauses.push(target.agencyClause(agency.toUpperCase(), agency.toLowerCase()));
    } else if (target.agencyScope === 'attributes') {
      clauses.push(this.agencyScopeForServices(agency, target.agencyFacets));
    } else if (target.agencyScope === 'freetext') {
      // The agency is inside an unparsed message body, so there is no facet to
      // filter on. Free-text matching is case insensitive -- unlike facets --
      // so a single casing is enough here.
      //
      // A target can supply a precise token instead of the bare wildcard, which
      // matters: `*{AGENCY}*` matches hex fragments inside trace IDs for short
      // codes, and matches script names rather than tenants in event-log bodies.
      clauses.push(target.freetextTerm ? target.freetextTerm(agencyLower, env) : `*${agency.toUpperCase()}*`);
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
  private agencyScopeForServices(agency: string, only?: string[]): string {
    const upper = agency.toUpperCase();
    const lower = agency.toLowerCase();

    /*
     * A target can name the facets it actually has. Measured on
     * app-pci-payment-adapter over 7 days (283,218 lines): @SERV_PROV_CODE is
     * the only agency facet with any buckets at all, and @agencycode, @Agency,
     * @usr.agency and @Properties.log.Agency each return ZERO. OR-ing those four
     * in changes no result and adds four dead terms to a URL people have to read
     * -- and worse, it implies the tool checked something it did not.
     */
    if (only?.length) {
      const parts = only.flatMap((f) =>
        f === '@SERV_PROV_CODE'
          ? [`@SERV_PROV_CODE:*${lower}*`, `@SERV_PROV_CODE:*${upper}*`]
          : [`${f}:*${upper}*`]
      );
      return parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0];
    }

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
