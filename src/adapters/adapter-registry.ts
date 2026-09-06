// ============================================================
// AheadSub — Adapter Registry
// Manages site-specific adapters and selects the best one
// for the current page.
// ============================================================

import type { SiteAdapter } from './adapter-interface';
import { GenericHTML5Adapter } from './generic-html5';
import { KodikAdapter } from './kodik';

class AdapterRegistry {
  private adapters: SiteAdapter[] = [];

  constructor() {
    // Register adapters in priority order
    this.register(new KodikAdapter());      // Priority 100
    this.register(new GenericHTML5Adapter()); // Priority 1000
  }

  register(adapter: SiteAdapter): void {
    this.adapters.push(adapter);
    this.adapters.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Find the best adapter for the current page.
   * Tries site-specific adapters first (lower priority number),
   * falls back to generic.
   */
  findAdapter(url: string, doc?: Document): SiteAdapter {
    for (const adapter of this.adapters) {
      if (adapter.canHandle(url, doc)) {
        console.log(`[AheadSub] Using adapter: ${adapter.name}`);
        return adapter;
      }
    }

    // Should never reach here — generic adapter handles everything
    return this.adapters[this.adapters.length - 1]!;
  }

  getAll(): SiteAdapter[] {
    return [...this.adapters];
  }
}

// Singleton
export const adapterRegistry = new AdapterRegistry();
