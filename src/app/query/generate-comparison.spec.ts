import { writeFileSync } from 'node:fs';
import { TestBed } from '@angular/core/testing';
import { LegacyQueryBuilderService } from './legacy-query-builder.service';
import { QueryBuilderV2Service } from './query-builder-v2.service';
import { HOSTS, ADDITIONAL_SERVICES } from './environments.config';
import { QueryInput, QueryResult } from './query-input.model';

/**
 * Generates ENGINE_COMPARISON.md from the engines themselves.
 *
 * Committed deliberately. The first version of that document was produced by a
 * throwaway harness, which meant it silently went stale the moment either engine
 * changed -- and it did. This runs only when asked, so it costs nothing on a
 * normal `npm test`:
 *
 *   $env:DDFETCH_GEN_DOCS = '.\ENGINE_COMPARISON.md'
 *   npm test
 *
 * The value is the output path. Unset it afterwards.
 */

const OUT = process.env['DDFETCH_GEN_DOCS'];

/** Placeholder agency, so the document carries no real tenant code. */
const AGENCY = 'AGENCY';

interface Row {
  label: string;
  legacy: string;
  v2: string;
  change: 'SEMANTIC' | 'cosmetic' | 'unchanged';
}

describe.runIf(OUT)('ENGINE_COMPARISON.md generator', () => {
  let legacy: LegacyQueryBuilderService;
  let v2: QueryBuilderV2Service;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    legacy = TestBed.inject(LegacyQueryBuilderService);
    v2 = TestBed.inject(QueryBuilderV2Service);
  });

  function build(overrides: Partial<QueryInput>): { legacy: QueryResult; v2: QueryResult } {
    const input: QueryInput = {
      servProvCode: AGENCY,
      host: 'US',
      environment: 'PROD',
      applications: [],
      additionalServices: [],
      additionalParams: '',
      ...overrides,
    };
    return { legacy: legacy.build(input), v2: v2.build(input) };
  }

  /** Same logs, fewer parentheses -- compare with all brackets stripped. */
  function classify(a: string, b: string): Row['change'] {
    if (a === b) return 'unchanged';
    const bare = (s: string) => s.replace(/[()]/g, '');
    return bare(a) === bare(b) ? 'cosmetic' : 'SEMANTIC';
  }

  function row(label: string, overrides: Partial<QueryInput>): Row {
    const { legacy: l, v2: n } = build(overrides);
    return { label, legacy: l.query, v2: n.query, change: classify(l.query, n.query) };
  }

  function table(rows: Row[]): string {
    const head = '| Combination | Legacy | New (v2) | Change |\n|---|---|---|---|';
    const body = rows
      .map((r) => `| ${r.label} | \`${r.legacy}\` | \`${r.v2}\` | ${r.change} |`)
      .join('\n');
    return `${head}\n${body}`;
  }

  it('writes the document', () => {
    const appRows: Row[] = [];
    for (const host of HOSTS) {
      for (const env of host.environments) {
        for (const app of ['Civic Platform', 'Citizen Access', 'CAPI']) {
          appRows.push(
            row(`${host.ui} / ${env.ui} / ${app}`, {
              host: host.ui,
              environment: env.ui,
              applications: [app],
            })
          );
        }
      }
    }

    // Three host/environment combinations per service, chosen to show that the
    // legacy service clause was identical across all of them.
    const serviceContexts: Array<[string, string]> = [
      ['US', 'PROD'],
      ['AU', 'TEST'],
      ['CA', 'PROD'],
    ];
    const serviceRows: Row[] = [];
    for (const svc of ADDITIONAL_SERVICES) {
      for (const [host, environment] of serviceContexts) {
        serviceRows.push(
          row(`${host} / ${environment} / CivP + ${svc.ui}`, {
            host,
            environment,
            applications: ['Civic Platform'],
            additionalServices: [svc.ui],
          })
        );
      }
      serviceRows.push(
        row(`US / PROD / (no app) + ${svc.ui}`, {
          applications: [],
          additionalServices: [svc.ui],
        })
      );
    }

    const paramRows: Row[] = [
      row('US / PROD / CivP + two params', {
        applications: ['Civic Platform'],
        additionalParams: 'timeout "connection reset"',
      }),
      row('US / PROD / CivP + single quoted param', {
        applications: ['Civic Platform'],
        additionalParams: '"foo"',
      }),
      row('US / PROD / CivP + field filter param', {
        applications: ['Civic Platform'],
        additionalParams: '@USER_ID:someuser',
      }),
    ];

    const all = [...appRows, ...serviceRows, ...paramRows];
    const semantic = all.filter((r) => r.change === 'SEMANTIC').length;
    const cosmetic = all.filter((r) => r.change === 'cosmetic').length;
    const unchanged = all.filter((r) => r.change === 'unchanged').length;

    // Collect every distinct warning the new engine raises across the matrix,
    // with a count, rather than repeating them on each row.
    const warningCounts = new Map<string, number>();
    for (const r of all) {
      // Rebuild to read warnings; cheap enough at this size.
      const parts = r.label.split(' / ');
      const host = parts[0];
      const environment = parts[1];
      const rest = parts.slice(2).join(' / ');
      const apps = rest.includes('CivP') || rest.includes('Civic Platform')
        ? ['Civic Platform']
        : rest.includes('Citizen Access')
          ? ['Citizen Access']
          : rest.includes('CAPI')
            ? ['CAPI']
            : [];
      const svc = ADDITIONAL_SERVICES.find((s) => rest.endsWith(s.ui));
      const { v2: res } = build({
        host,
        environment,
        applications: apps,
        additionalServices: svc ? [svc.ui] : [],
      });
      for (const w of res.warnings) {
        warningCounts.set(w, (warningCounts.get(w) ?? 0) + 1);
      }
    }

    const warningTable = [
      '| Warning | Rows affected |',
      '|---|---|',
      ...[...warningCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([w, n]) => `| ${w} | ${n} |`),
    ].join('\n');

    const doc = `# DDFetch engine comparison

## Plain English summary

This is the complete set of queries DDFetch can generate, old engine against new, for every combination the UI allows. It exists so the new queries can be checked before anyone trusts them, and so that if a search starts behaving unexpectedly there is a reference for what changed.

Of ${all.length} combinations, ${semantic} change in a way that affects which logs come back, ${cosmetic} change only by losing redundant parentheses, and ${unchanged} are unchanged. A placeholder agency code appears throughout as \`${AGENCY}\` and \`${AGENCY.toLowerCase()}\`; substitute a real code when comparing against a live search. Combination labels use \`/\` as a separator so they do not collide with the table columns.

**Generated from the engines themselves** by \`src/app/query/generate-comparison.spec.ts\` -- see "Regenerating this file" at the end. Not written by hand.

## Legend

| Marker | Meaning |
|---|---|
| \`SEMANTIC\` | The set of logs returned changes |
| \`cosmetic\` | Same logs, fewer redundant parentheses |

Where the new engine raises a warning for a combination, it is listed in the warnings section at the end rather than repeated on every row.

## Applications, by host and environment

Each row is a single application selected on its own. Note that Citizen Access always pulls in the biz tier as well, because ACA is the front end and Civic Platform the back end.

${table(appRows)}

## Additional services

The core defect and its fix. Under the legacy engine the service clause is **identical** for \`US / PROD\` and \`AU / TEST\` -- the region and environment selections had no effect on it whatsoever, and neither did the agency.

The new engine emits one sub-branch per service target, because the targets do not agree on either scope. Environment lives on a different tag per log family, and \`event-log-service\`, \`av.ads\` and ConfigStore carry no agency field at all -- so AND-ing one agency clause across the whole branch used to exclude them silently.

${table(serviceRows)}

## Additional parameters

${table(paramRows)}

## Warnings raised by the new engine

The legacy engine raised none of these. It either produced a silently narrower query or a silently wider one.

${warningTable}

## Reading the two engines against each other

Four patterns account for nearly all the semantic differences.

**Service scoping.** Legacy emitted a bare \`OR (service:... OR name:... OR service:...)\` with no agency, environment or region filter, so ticking any payment or document service returned every tenant's logs in every region. The new engine gives each target its own scopes and warns where a scope cannot be expressed.

**Service names.** \`config-store-service\` does not exist and returned zero logs; it is \`configstore-service\`. Every legacy payment query carried that dead clause.

**Environment precision.** Legacy matched the CAPI environment as \`*PROD*\`, which also matches \`NONPROD1\` through \`NONPROD4\`, \`AUPROD\` and \`PRODCA\`. The new engine matches exactly, adds the cluster \`env:\` tag to separate US from AU, and corrects two values that never existed -- US staging is \`STAGE\`, not \`STG\`, and AU production is \`AUPROD\`, not \`PROD\`.

**ACA identification.** Legacy relied on a free-text agency match plus a filename token. The new engine adds \`@agencycode\`, which catches ACA lines carrying no agency token in the message body. Two Oregon cases were corrected against live data: TRAIN is genuinely single-tenant so its filename stays hardcoded, and STG collects no ACA logs at all so it warns instead of filtering.

## Regenerating this file

There is now a committed harness. From the repository root:

\`\`\`powershell
$env:DDFETCH_GEN_DOCS = 'F:\\Claude\\TOOLS\\DDFETCH\\ENGINE_COMPARISON.md'
npm test
Remove-Item Env:\\DDFETCH_GEN_DOCS
\`\`\`

The generator is skipped entirely when that variable is unset, so it does not slow a normal test run. It requires \`@types/node\`, which is a dev dependency and is excluded from the application build by \`"types": []\` in \`tsconfig.app.json\`.
`;

    writeFileSync(OUT!, doc, 'utf8');
    expect(all.length).toBeGreaterThan(100);
  });
});
