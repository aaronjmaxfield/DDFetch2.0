import { TestBed } from '@angular/core/testing';
import { QueryBuilderV2Service } from './query-builder-v2.service';
import { QueryInput } from './query-input.model';

/**
 * The form offers "use Raw logs?" only while a Scope is picked (2026-10-01),
 * on the grounds that every filter raw mode removes is scope-gated. This pins
 * that: if an unscoped query ever starts filtering something, this fails and
 * the form's `rawModeApplies` has to be revisited.
 */
describe('Raw mode with no scope', () => {
  let v2: QueryBuilderV2Service;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    v2 = TestBed.inject(QueryBuilderV2Service);
  });

  const cases: [string, Partial<QueryInput>][] = [
    ['Civic Platform + Citizen Access', {}],
    ['Civic Platform only', { applications: ['Civic Platform'] }],
    ['Citizen Access only', { applications: ['Citizen Access'] }],
    ['with a service', { additionalServices: ['Forte'] }],
    ['with Construct API', { applications: ['Civic Platform', 'CAPI'] }],
    ['in SUPP', { environment: 'SUPP' }],
  ];

  it.each(cases)('changes nothing: %s', (_name, overrides) => {
    const input: QueryInput = {
      servProvCode: 'AGCY',
      host: 'US',
      environment: 'PROD',
      applications: ['Civic Platform', 'Citizen Access'],
      additionalServices: [],
      additionalParams: '',
      ...overrides,
    };
    const normal = v2.build(input);
    expect(normal.query).not.toBe('');
    expect(v2.build({ ...input, rawMode: true }).query).toBe(normal.query);
  });
});
