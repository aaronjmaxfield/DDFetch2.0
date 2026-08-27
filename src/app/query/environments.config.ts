/**
 * Declarative host / environment / service tables used by the v2 engine.
 *
 * The legacy engine expressed all of this as nested switch statements, which is
 * where the Oregon special-cases hid. Keeping it as data makes the gaps visible
 * and turns a correction into a one-line edit.
 *
 * -------------------------------------------------------------------------
 * PROVENANCE
 * -------------------------------------------------------------------------
 * Values marked CONFIRMED were read from live Datadog on 2026-08-27 over a
 * 7-to-30-day window using a local Datadog API script, dd-query.ps1 (Measure-DDLogs
 * facet aggregation). Values still marked ASSUMPTION were not observed -- in
 * every case because that environment produced no logs in the window, not
 * because the query failed.
 *
 * The single most important discovery: **there is no one environment tag.**
 * Each log family carries its own taxonomy, and they do not overlap.
 *
 *   family        field    example values
 *   ------------  -------  --------------------------------------------------
 *   civp (biz,    env      civp_prod_azure, civp_auprod_azure, civp_orstg_azure
 *   ACDS, ADS)             -- i.e. civp_{jndi}_azure, so it tracks `jndi`
 *   platform      env      prod, stg, nonprod, au-nonprod, ca-nonprod, qa, dev
 *   (PAS, event-           -- region-agnostic for prod; regionalised only for
 *   log)                      non-prod, and only on some services
 *   pci           env      prod-pci, nonprod-pci, eng-arch-pci
 *   capi          env      construct_prod_central_azure, construct_auprod_azure
 *   Paypal UI     env      azureprod-{agency}-prod -- per tenant, so the env
 *                          tag doubles as the agency filter
 *
 * This is why the earlier single `envTag` field could never work: it held the
 * @JNDI token, which is correct for the civp family and wrong for every other.
 * Adding `env:prod` to a payment query returned zero results because the value
 * being sent was `supp`, `auprod`, `prodca` and so on -- tokens that exist in
 * the civp taxonomy and nowhere else.
 */

export interface EnvironmentDef {
  /** Value shown in the Environment dropdown. */
  ui: string;
  /** Token used inside @JNDI for the biz tier. Long-standing, load-bearing. */
  jndi: string;
  /**
   * Complete host clause for the biz tier.
   *
   * This is a full clause rather than a token because US STG cannot be
   * expressed as one: `host:*stg*` also matches austg, castg and orstg. The
   * exclusion form below is provably correct from the other regions' own
   * tokens, without needing to know the US staging hostname.
   */
  hostClause: string;
  /**
   * `env:` value carried by the civp log family -- biz tier, ACDS, edms-handler
   * and ADS. Always of the form `civp_{token}_azure`.
   *
   * `undefined` means no such tag was observed, in which case the v2 engine
   * warns rather than emitting a clause that would return nothing.
   */
  civpEnv?: string;
  /**
   * `env:` values carried by the payment platform family -- payment-adapter-service
   * and event-log-service. An array because the two services disagree: PAS uses a
   * bare `nonprod` while event-log-service regionalises it as `au-nonprod` /
   * `ca-nonprod`. Emitted as `env:(a OR b)`.
   */
  platformEnv?: string[];
  /** `env:` value on the separate PCI cluster (SecurePay / Payrix / Worldpay). */
  pciEnv?: string;
  /**
   * Exact @Properties.log.EnvName for CAPI.
   *
   * Note this is *not* interchangeable with the `env:` tag -- a single CAPI
   * cluster carries many EnvName values, so region comes from `capiRegionClause`
   * on the host and environment comes from here.
   */
  capiEnvName: string;
  /**
   * filename: token for the ACA tier. `undefined` means ACA logs are not
   * collected for this environment -- v2 raises a visible warning instead of
   * dropping the filter silently the way legacy did.
   */
  acaFilename?: (agencyLower: string) => string;
}

export interface HostDef {
  ui: string;
  /** OREGON does not use @JNDI at all. */
  usesJndi: boolean;
  /**
   * Extra clause pinning CAPI to this region.
   *
   * CONFIRMED: CAPI runs in a small number of named clusters, identified by the
   * `env:` tag, and that -- not @Properties.log.EnvName -- is what separates the
   * regions. `construct_auprod_azure` emits EnvName values PROD, AUPROD,
   * NONPROD1, NONPROD2, STAGE, SUPP and TEST, so EnvName alone cannot tell an
   * AU log from a US one.
   */
  capiRegionClause: string;
  /** Set when CAPI has no cluster of its own for this region. */
  capiRegionNote?: string;
  environments: EnvironmentDef[];
}

/** `AGCY-PROD` style suffix used by the generic ACA filename convention. */
const generic = (env: string) => (agencyLower: string) => `${agencyLower}-${env}`;
/** Oregon uses `{agency}-or{env}-aca`. CONFIRMED for PROD. */
const oregon = (env: string) => (agencyLower: string) => `${agencyLower}-or${env}-aca`;
/** Oregon TRAIN is genuinely one tenant -- see the note on that row. */
const literal = (value: string) => () => value;

const usNonProdHost = 'host:*mtsup*';

/** CAPI's US-region clusters. CONFIRMED: these three plus two perf clusters. */
const usCapiClusters =
  'env:(construct_prod_central_azure OR construct_staging_azure OR construct_qa_azure)';

export const HOSTS: HostDef[] = [
  {
    ui: 'US',
    usesJndi: true,
    capiRegionClause: usCapiClusters,
    environments: [
      { ui: 'PROD', jndi: 'prod', hostClause: 'host:*mtprd*', civpEnv: 'civp_prod_azure', platformEnv: ['prod'], pciEnv: 'prod-pci', capiEnvName: 'PROD', acaFilename: generic('prod') },
      { ui: 'SUPP', jndi: 'supp', hostClause: usNonProdHost, civpEnv: 'civp_supp_azure', platformEnv: ['nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'SUPP', acaFilename: generic('supp') },
      // ASSUMPTION (civpEnv): no `civp_test_azure` tag exists. US TEST biz logs
      // may be one of the civp_int*_azure clusters; not resolved.
      { ui: 'TEST', jndi: 'test', hostClause: usNonProdHost, platformEnv: ['nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'TEST', acaFilename: generic('test') },
      {
        ui: 'STG',
        jndi: 'stg',
        // See hostClause docs -- plain `host:*stg*` leaks every other region.
        hostClause: '(host:*stg* AND -host:*austg* AND -host:*castg* AND -host:*orstg*)',
        civpEnv: 'civp_stg_azure',
        platformEnv: ['stg'],
        pciEnv: 'nonprod-pci',
        // CORRECTED: the EnvName is STAGE, not STG. `STG` matches nothing.
        capiEnvName: 'STAGE',
        acaFilename: generic('stg'),
      },
      // ASSUMPTION (civpEnv) for all four: no civp_nonprod{n}_azure tag exists.
      { ui: 'NONPROD1', jndi: 'nonprod1', hostClause: usNonProdHost, platformEnv: ['nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'NONPROD1', acaFilename: generic('nonprod1') },
      { ui: 'NONPROD2', jndi: 'nonprod2', hostClause: usNonProdHost, platformEnv: ['nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'NONPROD2', acaFilename: generic('nonprod2') },
      { ui: 'NONPROD3', jndi: 'nonprod3', hostClause: usNonProdHost, platformEnv: ['nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'NONPROD3', acaFilename: generic('nonprod3') },
      { ui: 'NONPROD4', jndi: 'nonprod4', hostClause: usNonProdHost, platformEnv: ['nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'NONPROD4', acaFilename: generic('nonprod4') },
      // ASSUMPTION (civpEnv): `civp_civcon_azure` is a high-volume tag and is the
      // only plausible match for CVCN, but the mapping was not confirmed.
      // ASSUMPTION (capiEnvName): no CVCN EnvName was observed.
      { ui: 'CVCN', jndi: 'cvcn', hostClause: 'host:*cvcn*', civpEnv: 'civp_civcon_azure', platformEnv: ['nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'CVCN', acaFilename: generic('cvcn') },
    ],
  },
  {
    ui: 'AU',
    usesJndi: true,
    // CONFIRMED: AU CAPI has its own cluster.
    capiRegionClause: 'env:construct_auprod_azure',
    environments: [
      // CORRECTED: AU production CAPI is AUPROD. The AU cluster also emits PROD,
      // which is why the region clause above is doing the real work.
      { ui: 'PROD', jndi: 'auprod', hostClause: 'host:*auprd*', civpEnv: 'civp_auprod_azure', platformEnv: ['prod'], pciEnv: 'prod-pci', capiEnvName: 'AUPROD', acaFilename: generic('auprod') },
      { ui: 'SUPP', jndi: 'ausupp', hostClause: 'host:*ausup*', civpEnv: 'civp_ausupp_azure', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'SUPP', acaFilename: generic('ausupp') },
      // ASSUMPTION (civpEnv): no civp_autest_azure tag exists.
      { ui: 'TEST', jndi: 'autest', hostClause: 'host:*ausup*', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'TEST', acaFilename: generic('autest') },
      // CORRECTED: AUSTG, not STG.
      { ui: 'STG', jndi: 'austg', hostClause: 'host:*austg*', civpEnv: 'civp_austg_azure', platformEnv: ['stg'], pciEnv: 'nonprod-pci', capiEnvName: 'AUSTG', acaFilename: generic('austg') },
      { ui: 'NONPROD1', jndi: 'nonprod1', hostClause: 'host:*ausup*', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'NONPROD1', acaFilename: generic('nonprod1') },
      { ui: 'NONPROD2', jndi: 'nonprod2', hostClause: 'host:*ausup*', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'NONPROD2', acaFilename: generic('nonprod2') },
      { ui: 'NONPROD3', jndi: 'nonprod3', hostClause: 'host:*ausup*', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'NONPROD3', acaFilename: generic('nonprod3') },
      { ui: 'NONPROD4', jndi: 'nonprod4', hostClause: 'host:*ausup*', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'NONPROD4', acaFilename: generic('nonprod4') },
      // ASSUMPTION (capiEnvName): no CONV EnvName was observed.
      { ui: 'CONV', jndi: 'auconv', hostClause: 'host:*auconv*', civpEnv: 'civp_auconv_azure', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'CONV', acaFilename: generic('auconv') },
    ],
  },
  {
    ui: 'CA',
    usesJndi: true,
    capiRegionClause: '',
    capiRegionNote:
      'No Canadian CAPI cluster was found in Datadog, and no PRODCA or STGCA EnvName value exists. A CA CAPI search is unlikely to return anything.',
    environments: [
      { ui: 'PROD', jndi: 'prodca', hostClause: 'host:*caprd*', civpEnv: 'civp_prodca_azure', platformEnv: ['prod'], pciEnv: 'prod-pci', capiEnvName: 'PROD', acaFilename: generic('prodca') },
      { ui: 'STG', jndi: 'stgca', hostClause: 'host:*castg*', civpEnv: 'civp_stgca_azure', platformEnv: ['stg'], pciEnv: 'nonprod-pci', capiEnvName: 'STAGE', acaFilename: generic('stgca') },
      // ASSUMPTION (civpEnv) for all four: `civp_suppca_azure` exists and is
      // busy, but there is no SUPP entry in this dropdown to map it to, and
      // guessing which NONPROD it corresponds to would break the others.
      { ui: 'NONPROD1', jndi: 'nonprod1', hostClause: 'host:*casup*', platformEnv: ['ca-nonprod', 'nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'NONPROD1', acaFilename: generic('nonprod1') },
      { ui: 'NONPROD2', jndi: 'nonprod2', hostClause: 'host:*casup*', platformEnv: ['ca-nonprod', 'nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'NONPROD2', acaFilename: generic('nonprod2') },
      { ui: 'NONPROD3', jndi: 'nonprod3', hostClause: 'host:*casup*', platformEnv: ['ca-nonprod', 'nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'NONPROD3', acaFilename: generic('nonprod3') },
      { ui: 'NONPROD4', jndi: 'nonprod4', hostClause: 'host:*casup*', platformEnv: ['ca-nonprod', 'nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'NONPROD4', acaFilename: generic('nonprod4') },
    ],
  },
  {
    ui: 'OREGON',
    usesJndi: false,
    // Oregon has no CAPI cluster of its own -- its EnvName values (CONFIG, DEV)
    // appear inside the US clusters, so the US region clause is the right one.
    capiRegionClause: usCapiClusters,
    capiRegionNote:
      'Oregon CAPI logs are emitted from the US clusters, and Oregon PROD shares the EnvName value PROD with US PROD, so an Oregon PROD CAPI search cannot be separated from a US one.',
    environments: [
      { ui: 'PROD', jndi: 'orprd', hostClause: 'host:*orprd*', civpEnv: 'civp_orprd_azure', platformEnv: ['prod'], pciEnv: 'prod-pci', capiEnvName: 'PROD', acaFilename: oregon('prd') },
      {
        ui: 'TRAIN',
        jndi: 'ortest',
        // CORRECTED, twice over. TRAIN runs on `orsupp-*` hosts: the only host
        // emitting oregon-oregon-train-aca_debug.log is orsupp-aca-0/1. The old
        // `host:*ortest*` matched a single idle ACA node and missed the tier
        // entirely. `ortest` is kept in the OR because ortest-ACA-0 does log.
        hostClause: '(host:*orsupp* OR host:*ortest*)',
        civpEnv: 'civp_oregon-train_azure',
        platformEnv: ['nonprod'],
        pciEnv: 'nonprod-pci',
        // ASSUMPTION: no TRAIN EnvName was observed.
        capiEnvName: 'TRAIN',
        // CONFIRMED single-tenant. `oregon-oregon-train-aca_debug.log` is the
        // only ACA debug log in this environment, so the legacy hardcoded
        // literal was right and parameterising it on the agency code was wrong.
        acaFilename: literal('oregon-oregon-train-aca'),
      },
      // ACA logs are not collected in DEV/CONFIG -- acaFilename omitted so v2
      // warns instead of silently dropping the user's selection.
      { ui: 'DEV', jndi: 'ordev', hostClause: 'host:*ordev*', civpEnv: 'civp_oregon-dev_azure', platformEnv: ['nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'DEV' },
      { ui: 'CONFIG', jndi: 'orconf', hostClause: 'host:*orconf*', civpEnv: 'civp_orconf_azure', platformEnv: ['nonprod'], pciEnv: 'nonprod-pci', capiEnvName: 'CONFIG' },
      // CORRECTED: acaFilename removed. Oregon STG ships no ACA logs at all --
      // civp_orstg_azure contains av.biz, iis, av.indexer and av.web only, and
      // orstg-ACA-0 emits nothing but IIS access logs. The previous
      // `{agency}-orstg-aca` value would always have returned zero.
      { ui: 'STG', jndi: 'orstg', hostClause: 'host:*orstg*', civpEnv: 'civp_orstg_azure', platformEnv: ['stg'], pciEnv: 'nonprod-pci', capiEnvName: 'STAGE' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Additional services
// ---------------------------------------------------------------------------

/**
 * Resolves the environment clause for one family of service logs.
 *
 * Returns `undefined` when the environment cannot be expressed, which the
 * engine reports as a warning rather than emitting a clause that matches
 * nothing.
 */
export type EnvClause = (env: EnvironmentDef, agencyLower: string) => string | undefined;

const civpEnvClause: EnvClause = (env) => (env.civpEnv ? `env:${env.civpEnv}` : undefined);

const platformEnvClause: EnvClause = (env) =>
  env.platformEnv?.length
    ? env.platformEnv.length > 1
      ? `env:(${env.platformEnv.join(' OR ')})`
      : `env:${env.platformEnv[0]}`
    : undefined;

const pciEnvClause: EnvClause = (env) => (env.pciEnv ? `env:${env.pciEnv}` : undefined);

/**
 * Paypal UI tags every log with `azure{cluster}-{agency}-{env}`, so its env tag
 * already carries the agency. That makes it the only service where one clause
 * covers both scopes.
 */
const paypalUiEnvClause: EnvClause = (_env, agencyLower) => `env:azure*-${agencyLower}-*`;

export interface ServiceTarget {
  /** Whether these logs are identified by `service:` or by `name:`. */
  field: 'service' | 'name';
  values: string[];
  /** How to scope this target to an environment. */
  envClause: EnvClause;
  /**
   * False when the logs carry no usable agency field. AND-ing the agency scope
   * onto these excludes them completely, which is how the previous version
   * silently dropped every event-log-service, ADS and ConfigStore line.
   */
  agencyScoped: boolean;
  /** Surfaced to the user whenever this target is included. */
  note?: string;
}

export interface ServiceDef {
  /** Checkbox label. */
  ui: string;
  /** Grouping used to enforce "pick only one". */
  category: 'payment' | 'document';
  targets: ServiceTarget[];
}

/** payment-adapter-service. CONFIRMED to carry @SERV_PROV_CODE, both casings. */
const paymentAdapter: ServiceTarget = {
  field: 'service',
  values: ['payment-adapter-service'],
  envClause: platformEnvClause,
  agencyScoped: true,
};

/**
 * CORRECTED service name: `configstore-service`, not `config-store-service`.
 * The hyphenated form returns zero logs over any window -- every Forte, PayPal
 * and SecurePay query built by the previous version carried a dead clause.
 */
const configStore: ServiceTarget = {
  field: 'service',
  values: ['configstore-service'],
  envClause: () => undefined,
  agencyScoped: false,
  note: 'ConfigStore logs carry no agency or environment tag, and only the staging instance (configstore-service-stg) ships to Datadog, so a production ConfigStore search will return nothing.',
};

/** CONFIRMED: no @SERV_PROV_CODE and no agency attribute of any kind. */
const eventLog: ServiceTarget = {
  field: 'name',
  values: ['event-log-service'],
  envClause: platformEnvClause,
  agencyScoped: false,
  note: 'event-log-service logs carry no agency field, so they are returned for the whole environment rather than just this agency.',
};

export const ADDITIONAL_SERVICES: ServiceDef[] = [
  {
    ui: 'Forte',
    category: 'payment',
    targets: [paymentAdapter, configStore, eventLog],
  },
  {
    ui: 'Paypal Commerce',
    category: 'payment',
    targets: [
      paymentAdapter,
      configStore,
      eventLog,
      {
        field: 'service',
        values: ['"Paypal UI"'],
        envClause: paypalUiEnvClause,
        agencyScoped: false,
        note: 'Paypal UI is scoped by its own env tag, which embeds the agency, so it needs no separate agency filter.',
      },
    ],
  },
  {
    ui: 'SecurePay',
    category: 'payment',
    targets: [
      {
        // CONFIRMED: the service exists, runs on the PCI clusters, and carries
        // @SERV_PROV_CODE, @MODULE, @PLATFORM and @PROVIDER like PAS does.
        field: 'service',
        values: ['app-pci-payment-adapter'],
        envClause: pciEnvClause,
        agencyScoped: true,
        note: 'SecurePay runs on a separate PCI cluster (env prod-pci / nonprod-pci). Nearly all current traffic is on the engineering cluster eng-arch-pci, which this search does not include.',
      },
      {
        field: 'service',
        values: ['app-pci-configstore'],
        envClause: pciEnvClause,
        agencyScoped: false,
      },
      eventLog,
    ],
  },
  {
    ui: 'ACDS',
    category: 'document',
    targets: [
      {
        // CONFIRMED: both carry @SERV_PROV_CODE, and env is civp_{jndi}_azure.
        field: 'service',
        values: ['acds', 'edms-handler'],
        envClause: civpEnvClause,
        agencyScoped: true,
      },
    ],
  },
  {
    ui: 'ADS',
    category: 'document',
    targets: [
      {
        field: 'service',
        values: ['av.ads'],
        envClause: civpEnvClause,
        // CONFIRMED: @SERV_PROV_CODE exists on av.ads but is always empty.
        agencyScoped: false,
        note: 'ADS logs carry no populated agency field, so they are returned for the whole environment rather than just this agency.',
      },
    ],
  },
];

export function findHost(ui: string): HostDef | undefined {
  return HOSTS.find((h) => h.ui === ui);
}

export function findEnvironment(hostUi: string, envUi: string): EnvironmentDef | undefined {
  return findHost(hostUi)?.environments.find((e) => e.ui === envUi.toUpperCase());
}

export function environmentsFor(hostUi: string): string[] {
  return findHost(hostUi)?.environments.map((e) => e.ui) ?? [];
}
