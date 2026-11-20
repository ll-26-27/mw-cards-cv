// Turns frame-by-frame detections into a steady list for the overlay. A card has to be seen
// in a couple of frames before it counts as showing, and has to be missed in a few before it
// is taken away, so one bad frame never flashes a graphic on or off in the studio.
import { parseCard, type Pred } from "./detector";
import type { PublishedCard } from "./lib/hub";

type Track = { hits: number; misses: number; shown: boolean; pred: Pred };

export class Stabilizer {
  private tracks = new Map<string, Track>();

  /**
   * Feed in one frame's detections. `appear` and `vanish` are how many consecutive frames a
   * card must be seen / missed to change state (1 and 1 trusts every frame).
   */
  update(preds: Pred[], frameW: number, frameH: number, appear = 2, vanish = 4): PublishedCard[] {
    const seen = new Set<string>();
    for (const pred of preds) {
      // A deck has one of each card, so the class is the identity.
      if (seen.has(pred.class)) continue;
      seen.add(pred.class);
      const track = this.tracks.get(pred.class);
      if (track) {
        track.hits++;
        track.misses = 0;
        track.pred = pred;
      } else {
        this.tracks.set(pred.class, { hits: 1, misses: 0, shown: false, pred });
      }
    }
    for (const [code, track] of this.tracks) {
      if (!seen.has(code)) {
        track.misses++;
        if (track.misses >= vanish || !track.shown) this.tracks.delete(code);
      } else if (track.hits >= appear) {
        track.shown = true;
      }
    }

    return [...this.tracks.values()]
      .filter((t) => t.shown)
      .sort((a, b) => a.pred.x - b.pred.x)
      .map(({ pred }) => {
        const card = parseCard(pred.class);
        return {
          code: pred.class,
          rank: card.rank,
          suit: card.suit,
          confidence: Math.round(pred.confidence * 1000) / 1000,
          x: pred.x / frameW,
          y: pred.y / frameH,
          width: pred.width / frameW,
          height: pred.height / frameH,
        };
      });
  }

  reset() {
    this.tracks.clear();
  }
}
