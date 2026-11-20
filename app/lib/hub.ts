// The latest stable cards per feed, held in memory by the Next server and pushed to every
// subscriber of /api/cards/stream. The detection pages POST here; overlay apps on other
// machines listen. Kept on globalThis so the routes share one hub across dev reloads.

export type PublishedCard = {
  /** "AS", "10H", ... */
  code: string;
  rank: string;
  suit: string;
  confidence: number;
  /** Box center and size as fractions of the camera frame (0..1). */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FeedState = { feed: string; cards: PublishedCard[]; updatedAt: number };
export type Snapshot = { feeds: FeedState[]; at: number };

/** A feed that has not posted for this long is dropped (its tab closed or crashed). */
const STALE_MS = 10_000;

type Listener = (snapshot: Snapshot) => void;

class Hub {
  private feeds = new Map<string, FeedState>();
  private listeners = new Set<Listener>();

  constructor() {
    const timer = setInterval(() => this.sweep(), 2000);
    timer.unref?.();
  }

  snapshot(): Snapshot {
    const feeds = [...this.feeds.values()].sort((a, b) => a.feed.localeCompare(b.feed));
    return { feeds, at: Date.now() };
  }

  /** Stores a feed's cards; subscribers hear about it only when the cards changed. */
  set(feed: string, cards: PublishedCard[]) {
    const before = this.feeds.get(feed);
    this.feeds.set(feed, { feed, cards, updatedAt: Date.now() });
    if (!before || signature(before.cards) !== signature(cards)) this.emit();
  }

  remove(feed: string) {
    if (this.feeds.delete(feed)) this.emit();
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscribers() {
    return this.listeners.size;
  }

  private sweep() {
    const cutoff = Date.now() - STALE_MS;
    let changed = false;
    for (const [feed, state] of this.feeds) {
      if (state.updatedAt < cutoff) {
        this.feeds.delete(feed);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private emit() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function signature(cards: PublishedCard[]) {
  return cards.map((c) => c.code).join(",");
}

const store = globalThis as typeof globalThis & { __cardsHub?: Hub };
export const hub = (store.__cardsHub ??= new Hub());
