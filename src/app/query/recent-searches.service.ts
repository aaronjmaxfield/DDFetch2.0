import { Injectable } from '@angular/core';

/**
 * One remembered agency/host/environment combination.
 *
 * `count` and `lastUsed` are both kept because "recently used" and "frequently
 * used" are different questions and the useful answer blends them: someone who
 * has typed one agency a hundred times today wants it first, but someone who has
 * just switched to a new agency wants that visible too.
 */
export interface RecentSearch {
  agency: string;
  host: string;
  environment: string;
  count: number;
  /** Epoch ms. */
  lastUsed: number;
}

const STORAGE_KEY = 'ddfetch.recentSearches.v1';

/** Kept small on purpose -- this is a shortcut, not a history feature. */
const MAX_STORED = 20;

/**
 * Remembers which agency and environment you actually work in, so it can be
 * offered back rather than retyped.
 *
 * -------------------------------------------------------------------------
 * WHY LOCALSTORAGE, AND WHY THAT IS NOT A COMPROMISE
 * -------------------------------------------------------------------------
 * The tool has no backend and holds no secrets -- it assembles a URL and hands
 * off to Datadog using the user's own session. That is what makes it deployable
 * as a static page and safe to hand around. A server-side "recent searches"
 * store would give that up for a convenience feature, so this stays in the
 * browser.
 *
 * -------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT STORED
 * -------------------------------------------------------------------------
 * Only the agency, host and environment. NOT the scoped identifier fields --
 * no CAP IDs, transaction IDs, document names, parcel numbers or trace IDs.
 * Those identify records, payments and people, and a shared or shoulder-surfed
 * machine should not carry a list of them. The agency/host/environment triple
 * is the part that gets retyped fifty times a day and the part that identifies
 * nobody.
 */
@Injectable({ providedIn: 'root' })
export class RecentSearchesService {
  /**
   * Most useful first. Frequency leads, recency breaks ties -- so the agency you
   * live in stays top, and among equals the last one you touched wins.
   */
  list(limit = 3): RecentSearch[] {
    return this.read()
      .sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed)
      .slice(0, limit);
  }

  /** Call on a successful submit, not on every keystroke. */
  record(agency: string, host: string, environment: string): void {
    const a = agency.trim().toUpperCase();
    if (!a || !host || !environment) return;

    const all = this.read();
    const found = all.find(
      (e) => e.agency === a && e.host === host && e.environment === environment
    );
    if (found) {
      found.count += 1;
      found.lastUsed = Date.now();
    } else {
      all.push({ agency: a, host, environment, count: 1, lastUsed: Date.now() });
    }

    // Trim by usefulness rather than by insertion order, so a one-off typo does
    // not evict the agency someone actually works in.
    const trimmed = all
      .sort((x, y) => y.count - x.count || y.lastUsed - x.lastUsed)
      .slice(0, MAX_STORED);
    this.write(trimmed);
  }

  clear(): void {
    this.write([]);
  }

  /*
   * Storage can throw rather than merely be empty -- Safari private mode throws
   * on setItem, and an iframe with third-party storage blocked throws on read.
   * A convenience feature must never take the form down with it, so every access
   * is guarded and a failure degrades to "no suggestions".
   */
  private read(): RecentSearch[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e): e is RecentSearch =>
          !!e &&
          typeof e.agency === 'string' &&
          typeof e.host === 'string' &&
          typeof e.environment === 'string' &&
          typeof e.count === 'number' &&
          typeof e.lastUsed === 'number'
      );
    } catch {
      return [];
    }
  }

  private write(entries: RecentSearch[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      /* No suggestions is an acceptable outcome; a broken form is not. */
    }
  }
}
