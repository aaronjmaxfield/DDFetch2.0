import { TestBed } from '@angular/core/testing';
import { RecentSearchesService } from './recent-searches.service';

/**
 * The value of this feature is that it removes three actions that are almost
 * always the same three values. The risk is that it remembers something it
 * should not, or that storage being unavailable takes the form down -- so both
 * are covered here rather than only the happy path.
 */
describe('RecentSearchesService', () => {
    let svc: RecentSearchesService;

    beforeEach(() => {
        localStorage.clear();
        TestBed.configureTestingModule({});
        svc = TestBed.inject(RecentSearchesService);
    });

    afterEach(() => localStorage.clear());

    it('remembers a combination and counts repeats rather than duplicating', () => {
        svc.record('CRC', 'US', 'TEST');
        svc.record('crc', 'US', 'TEST'); // casing normalised
        svc.record('CRC', 'US', 'TEST');

        const list = svc.list();
        expect(list.length).toBe(1);
        expect(list[0].agency).toBe('CRC');
        expect(list[0].count).toBe(3);
    });

    it('treats a different environment as a different entry', () => {
        // CRC TEST and CRC SUPP are genuinely different searches -- the document
        // investigation on 2026-09-02 turned on exactly that distinction.
        svc.record('CRC', 'US', 'TEST');
        svc.record('CRC', 'US', 'SUPP');
        expect(svc.list().length).toBe(2);
    });

    it('ranks by frequency, breaking ties on recency', () => {
        svc.record('RARE', 'US', 'PROD');
        for (let i = 0; i < 5; i++) svc.record('DAILY', 'US', 'TEST');

        const list = svc.list();
        expect(list[0].agency).toBe('DAILY');
        expect(list[1].agency).toBe('RARE');
    });

    it('returns at most the requested number', () => {
        for (const a of ['A', 'B', 'C', 'D', 'E']) svc.record(a, 'US', 'PROD');
        expect(svc.list(3).length).toBe(3);
        expect(svc.list(2).length).toBe(2);
    });

    it('ignores an incomplete combination', () => {
        svc.record('', 'US', 'PROD');
        svc.record('CRC', '', 'PROD');
        svc.record('CRC', 'US', '');
        expect(svc.list().length).toBe(0);
    });

    it('never stores anything that identifies a record or a person', () => {
        /*
         * The deliberate scope limit. Agency, host and environment identify an
         * organisation and an environment; CAP IDs, transaction IDs, document
         * names and trace IDs identify records, payments and people, and a
         * shared machine should not carry a list of them.
         */
        svc.record('CRC', 'US', 'TEST');
        const raw = localStorage.getItem('ddfetch.recentSearches.v1') ?? '';
        const stored = JSON.parse(raw);
        expect(Object.keys(stored[0]).sort()).toEqual([
            'agency',
            'count',
            'environment',
            'host',
            'lastUsed',
        ]);
    });

    it('survives corrupt storage instead of throwing', () => {
        localStorage.setItem('ddfetch.recentSearches.v1', '{not json');
        expect(svc.list()).toEqual([]);
        expect(() => svc.record('CRC', 'US', 'TEST')).not.toThrow();
    });

    it('discards entries of the wrong shape', () => {
        // An older or hand-edited payload must not reach the template.
        localStorage.setItem(
            'ddfetch.recentSearches.v1',
            JSON.stringify([{ agency: 'CRC' }, null, { agency: 'OK', host: 'US', environment: 'PROD', count: 1, lastUsed: 1 }])
        );
        expect(svc.list().map((e) => e.agency)).toEqual(['OK']);
    });

    it('trims by usefulness, so a typo cannot evict the agency you live in', () => {
        for (let i = 0; i < 10; i++) svc.record('DAILY', 'US', 'TEST');
        // 25 one-off typos, well past the 20-entry cap.
        for (let i = 0; i < 25; i++) svc.record(`TYPO${i}`, 'US', 'PROD');
        expect(svc.list(1)[0].agency).toBe('DAILY');
    });

    it('clears on request', () => {
        svc.record('CRC', 'US', 'TEST');
        svc.clear();
        expect(svc.list()).toEqual([]);
    });
});
