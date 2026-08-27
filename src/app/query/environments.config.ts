/**
 * Declarative host / environment / service tables used by the v2 engine.
 *
 * The legacy engine expressed all of this as nested switch statements, which is
 * where the Oregon special-cases hid. Keeping it as data makes the gaps visible
 * and turns a correction into a one-line edit.
 *
 * -------------------------------------------------------------------------
 * UNVERIFIED VALUES
 * -------------------------------------------------------------------------
 * Every field marked ASSUMPTION below was carried over or inferred, and has NOT
 * been confirmed against live Datadog. Field *names* are confirmed to exist in
 * the log schema; these are the *values*. Confirm with:
 *
 *   SELECT service, env, COUNT(*) FROM dd.logs(
 *     columns => ARRAY['service','env'],
 *     filter => 'service:(*payment* OR *acds* OR *ads* OR *edms* OR *pci*)',
 *     from_timestamp => NOW() - INTERVAL '7 day', to_timestamp => NOW())
 *     AS (service VARCHAR, env VARCHAR)
 *   GROUP BY service, env ORDER BY 3 DESC
 *
 * If a v2 service query returns zero results, `envTag` here is the first thing
 * to check.
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
  /** env: tag value for containerised services (PAS, ACDS, ADS, CAPI). ASSUMPTION. */
  envTag: string;
  /** Exact @Properties.log.EnvName for CAPI. Confirmed for US; ASSUMPTION elsewhere. */
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
   * Extra clause to pin CAPI to this region.
   *
   * BLOCKED: CAPI currently cannot be scoped by region. Legacy sent the same
   * @Properties.log.EnvName for every host, so a US CAPI search also returns
   * AU/CA/OREGON CAPI logs. Fixing it needs the real region/site tag values,
   * which could not be read in this session. Leave '' until confirmed -- a
   * wrong value here returns zero results, which is worse than too many.
   */
  capiRegionClause: string;
  environments: EnvironmentDef[];
}

/** `AGCY-PROD` style suffix used by the generic ACA filename convention. */
const generic = (env: string) => (agencyLower: string) => `${agencyLower}-${env}`;
/** Oregon uses `{agency}-or{env}-aca`. ASSUMPTION for STG/TRAIN. */
const oregon = (env: string) => (agencyLower: string) => `${agencyLower}-or${env}-aca`;

const usNonProdHost = 'host:*mtsup*';

export const HOSTS: HostDef[] = [
  {
    ui: 'US',
    usesJndi: true,
    capiRegionClause: '',
    environments: [
      { ui: 'PROD', jndi: 'prod', hostClause: 'host:*mtprd*', envTag: 'prod', capiEnvName: 'PROD', acaFilename: generic('prod') },
      { ui: 'SUPP', jndi: 'supp', hostClause: usNonProdHost, envTag: 'supp', capiEnvName: 'SUPP', acaFilename: generic('supp') },
      { ui: 'TEST', jndi: 'test', hostClause: usNonProdHost, envTag: 'test', capiEnvName: 'TEST', acaFilename: generic('test') },
      {
        ui: 'STG',
        jndi: 'stg',
        // See hostClause docs -- plain `host:*stg*` leaks every other region.
        hostClause: '(host:*stg* AND -host:*austg* AND -host:*castg* AND -host:*orstg*)',
        envTag: 'stg',
        capiEnvName: 'STG',
        acaFilename: generic('stg'),
      },
      { ui: 'NONPROD1', jndi: 'nonprod1', hostClause: usNonProdHost, envTag: 'nonprod1', capiEnvName: 'NONPROD1', acaFilename: generic('nonprod1') },
      { ui: 'NONPROD2', jndi: 'nonprod2', hostClause: usNonProdHost, envTag: 'nonprod2', capiEnvName: 'NONPROD2', acaFilename: generic('nonprod2') },
      { ui: 'NONPROD3', jndi: 'nonprod3', hostClause: usNonProdHost, envTag: 'nonprod3', capiEnvName: 'NONPROD3', acaFilename: generic('nonprod3') },
      { ui: 'NONPROD4', jndi: 'nonprod4', hostClause: usNonProdHost, envTag: 'nonprod4', capiEnvName: 'NONPROD4', acaFilename: generic('nonprod4') },
      { ui: 'CVCN', jndi: 'cvcn', hostClause: 'host:*cvcn*', envTag: 'cvcn', capiEnvName: 'CVCN', acaFilename: generic('cvcn') },
    ],
  },
  {
    ui: 'AU',
    usesJndi: true,
    capiRegionClause: '',
    environments: [
      { ui: 'PROD', jndi: 'auprod', hostClause: 'host:*auprd*', envTag: 'auprod', capiEnvName: 'PROD', acaFilename: generic('auprod') },
      { ui: 'SUPP', jndi: 'ausupp', hostClause: 'host:*ausup*', envTag: 'ausupp', capiEnvName: 'SUPP', acaFilename: generic('ausupp') },
      { ui: 'TEST', jndi: 'autest', hostClause: 'host:*ausup*', envTag: 'autest', capiEnvName: 'TEST', acaFilename: generic('autest') },
      { ui: 'STG', jndi: 'austg', hostClause: 'host:*austg*', envTag: 'austg', capiEnvName: 'STG', acaFilename: generic('austg') },
      { ui: 'NONPROD1', jndi: 'nonprod1', hostClause: 'host:*ausup*', envTag: 'nonprod1', capiEnvName: 'NONPROD1', acaFilename: generic('nonprod1') },
      { ui: 'NONPROD2', jndi: 'nonprod2', hostClause: 'host:*ausup*', envTag: 'nonprod2', capiEnvName: 'NONPROD2', acaFilename: generic('nonprod2') },
      { ui: 'NONPROD3', jndi: 'nonprod3', hostClause: 'host:*ausup*', envTag: 'nonprod3', capiEnvName: 'NONPROD3', acaFilename: generic('nonprod3') },
      { ui: 'NONPROD4', jndi: 'nonprod4', hostClause: 'host:*ausup*', envTag: 'nonprod4', capiEnvName: 'NONPROD4', acaFilename: generic('nonprod4') },
      { ui: 'CONV', jndi: 'auconv', hostClause: 'host:*auconv*', envTag: 'auconv', capiEnvName: 'CONV', acaFilename: generic('auconv') },
    ],
  },
  {
    ui: 'CA',
    usesJndi: true,
    capiRegionClause: '',
    environments: [
      { ui: 'PROD', jndi: 'prodca', hostClause: 'host:*caprd*', envTag: 'prodca', capiEnvName: 'PROD', acaFilename: generic('prodca') },
      { ui: 'STG', jndi: 'stgca', hostClause: 'host:*castg*', envTag: 'stgca', capiEnvName: 'STG', acaFilename: generic('stgca') },
      { ui: 'NONPROD1', jndi: 'nonprod1', hostClause: 'host:*casup*', envTag: 'nonprod1', capiEnvName: 'NONPROD1', acaFilename: generic('nonprod1') },
      { ui: 'NONPROD2', jndi: 'nonprod2', hostClause: 'host:*casup*', envTag: 'nonprod2', capiEnvName: 'NONPROD2', acaFilename: generic('nonprod2') },
      { ui: 'NONPROD3', jndi: 'nonprod3', hostClause: 'host:*casup*', envTag: 'nonprod3', capiEnvName: 'NONPROD3', acaFilename: generic('nonprod3') },
      { ui: 'NONPROD4', jndi: 'nonprod4', hostClause: 'host:*casup*', envTag: 'nonprod4', capiEnvName: 'NONPROD4', acaFilename: generic('nonprod4') },
    ],
  },
  {
    ui: 'OREGON',
    usesJndi: false,
    capiRegionClause: '',
    environments: [
      { ui: 'PROD', jndi: 'orprd', hostClause: 'host:*orprd*', envTag: 'orprd', capiEnvName: 'PROD', acaFilename: oregon('prd') },
      // ASSUMPTION: legacy hardcoded `oregon-oregon-train-aca`, ignoring the
      // ServProvCode entirely. Parameterised here so a non-"oregon" tenant is
      // searchable at all; revert to the literal if TRAIN really is one tenant.
      { ui: 'TRAIN', jndi: 'ortest', hostClause: 'host:*ortest*', envTag: 'ortest', capiEnvName: 'TRAIN', acaFilename: oregon('train') },
      // ACA logs are not collected in DEV/CONFIG -- acaFilename omitted so v2
      // warns instead of silently dropping the user's selection.
      { ui: 'DEV', jndi: 'ordev', hostClause: 'host:*ordev*', envTag: 'ordev', capiEnvName: 'DEV' },
      { ui: 'CONFIG', jndi: 'orconf', hostClause: 'host:*orconf*', envTag: 'orconf', capiEnvName: 'CONFIG' },
      // ASSUMPTION: legacy used the generic `agcy-stg`, inconsistent with the
      // Oregon `-aca` convention used by PROD. Aligned here.
      { ui: 'STG', jndi: 'orstg', hostClause: 'host:*orstg*', envTag: 'orstg', capiEnvName: 'STG', acaFilename: oregon('stg') },
    ],
  },
];

export interface ServiceDef {
  /** Checkbox label. */
  ui: string;
  /** Grouping used to enforce "pick only one". */
  category: 'payment' | 'document';
  /** service: tag values. */
  services: string[];
  /** name: tag values (confirmed to be a real top-level log field). */
  names?: string[];
  /** Set when the service runs outside the normal env-tagged estate. */
  note?: string;
}

export const ADDITIONAL_SERVICES: ServiceDef[] = [
  {
    ui: 'Forte',
    category: 'payment',
    services: ['payment-adapter-service', 'config-store-service'],
    names: ['event-log-service'],
  },
  {
    ui: 'Paypal Commerce',
    category: 'payment',
    services: ['payment-adapter-service', 'config-store-service', '"Paypal UI"'],
    names: ['event-log-service'],
  },
  {
    // ASSUMPTION: SecurePay / Payrix / Worldpay runs on a separate PCI cluster.
    // Service name unconfirmed -- verify before relying on this entry.
    ui: 'SecurePay',
    category: 'payment',
    services: ['app-pci-payment-adapter', 'config-store-service'],
    names: ['event-log-service'],
    note: 'SecurePay runs on a separate PCI cluster; it may not carry the same env tag as the rest of the estate.',
  },
  { ui: 'ACDS', category: 'document', services: ['acds', 'edms-handler'] },
  { ui: 'ADS', category: 'document', services: ['av.ads'] },
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
