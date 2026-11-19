// In-browser playing-card detector: YOLO11s (sroot/lgd-cards-gen3) run with onnxruntime-web.
// The runtime + model are served from /public (see scripts/setup.mjs), loaded via <script> to
// keep the wasm files out of Next's bundler.
import type * as Ort from "onnxruntime-web";

declare global {
  interface Window {
    ort?: typeof Ort;
  }
}

export type Card = { rank: string; suit: string; raw: string };
export type Pred = {
  class: string;
  confidence: number;
  // center x/y + size, in source-image pixels
  x: number;
  y: number;
  width: number;
  height: number;
};

const MODEL_URL = "/models/cards.onnx";
const ORT_URL = "/ort/ort.min.js";
const SIZE = 640;

// Class order from the model's metadata (model.classes.json).
const CLASSES = [
  "10C", "10D", "10H", "10S", "2C", "2D", "2H", "2S", "3C", "3D", "3H", "3S",
  "4C", "4D", "4H", "4S", "5C", "5D", "5H", "5S", "6C", "6D", "6H", "6S",
  "7C", "7D", "7H", "7S", "8C", "8D", "8H", "8S", "9C", "9D", "9H", "9S",
  "AC", "AD", "AH", "AS", "JC", "JD", "JH", "JS", "KC", "KD", "KH", "KS",
  "QC", "QD", "QH", "QS",
];

const SUITS: Record<string, string> = { C: "clubs", D: "diamonds", H: "hearts", S: "spades" };

export function parseCard(code: string): Card {
  const m = code.match(/^(10|[2-9AJQK])([CDHS])$/);
  if (!m) return { rank: code, suit: "", raw: code };
  return { rank: m[1], suit: SUITS[m[2]], raw: code };
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

let sessionPromise: Promise<{ session: Ort.InferenceSession; backend: string }> | null = null;

export function loadDetector() {
  sessionPromise ??= (async () => {
    if (!window.ort) await loadScript(ORT_URL);
    const ort = window.ort!;
    ort.env.wasm.wasmPaths = "/ort/";
    // ORT logs a benign "some nodes not assigned to the preferred EP" warning via console.error,
    // which Next's dev overlay surfaces as an error.
    ort.env.logLevel = "error";
    if (crossOriginIsolated) ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);

    const backends = "gpu" in navigator ? ["webgpu", "wasm"] : ["wasm"];
    let lastErr: unknown;
    for (const backend of backends) {
      try {
        const session = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: [backend],
          graphOptimizationLevel: "all",
          logSeverityLevel: 3, // errors only
        });
        return { session, backend };
      } catch (e) {
        lastErr = e;
      }
    }
    sessionPromise = null;
    throw lastErr;
  })();
  return sessionPromise;
}

let letterbox: HTMLCanvasElement | null = null;

function iou(a: number[], b: number[]) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const area = (r: number[]) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter);
}

export async function detect(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  conf = 0.4,
): Promise<{ cards: Card[]; preds: Pred[]; backend: string }> {
  const { session, backend } = await loadDetector();
  const ort = window.ort!;

  // Letterbox into a 640x640 gray square, as the model was trained.
  const r = Math.min(SIZE / srcW, SIZE / srcH);
  const nw = Math.round(srcW * r);
  const nh = Math.round(srcH * r);
  const px = Math.floor((SIZE - nw) / 2);
  const py = Math.floor((SIZE - nh) / 2);
  letterbox ??= Object.assign(document.createElement("canvas"), { width: SIZE, height: SIZE });
  const ctx = letterbox.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(source, px, py, nw, nh);
  const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data;

  // RGBA HWC uint8 -> RGB CHW float [0,1]
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = rgba[i * 4] / 255;
    input[plane + i] = rgba[i * 4 + 1] / 255;
    input[2 * plane + i] = rgba[i * 4 + 2] / 255;
  }

  const out = await session.run({ images: new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]) });
  const t = out[session.outputNames[0]];
  const data = (await t.getData()) as Float32Array;
  const n = t.dims[2]; // output is [1, 4 + classes, anchors]

  // Pick the best class per anchor, then per-class NMS.
  const cand: { cls: number; score: number; box: number[] }[] = [];
  for (let a = 0; a < n; a++) {
    let best = 0;
    let cls = -1;
    for (let c = 0; c < CLASSES.length; c++) {
      const s = data[(4 + c) * n + a];
      if (s > best) {
        best = s;
        cls = c;
      }
    }
    if (best < conf) continue;
    const cx = (data[a] - px) / r;
    const cy = (data[n + a] - py) / r;
    const w = data[2 * n + a] / r;
    const h = data[3 * n + a] / r;
    cand.push({ cls, score: best, box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] });
  }
  cand.sort((a, b) => b.score - a.score);
  const kept: typeof cand = [];
  for (const d of cand) {
    if (!kept.some((k) => k.cls === d.cls && iou(k.box, d.box) > 0.45)) kept.push(d);
  }

  // The model boxes each card's corner index, so a card usually yields two boxes (one per
  // corner). Merge same-class boxes that are near each other into one card spanning both.
  const merged: typeof kept = [];
  for (const d of kept) {
    const diag = Math.hypot(d.box[2] - d.box[0], d.box[3] - d.box[1]);
    const m = merged.find((k) => {
      if (k.cls !== d.cls) return false;
      const dx = (k.box[0] + k.box[2] - d.box[0] - d.box[2]) / 2;
      const dy = (k.box[1] + k.box[3] - d.box[1] - d.box[3]) / 2;
      return Math.hypot(dx, dy) < diag * 10;
    });
    if (m) {
      m.box = [
        Math.min(m.box[0], d.box[0]), Math.min(m.box[1], d.box[1]),
        Math.max(m.box[2], d.box[2]), Math.max(m.box[3], d.box[3]),
      ];
    } else {
      merged.push({ ...d, box: [...d.box] });
    }
  }

  const preds: Pred[] = merged
    .map((d) => ({
      class: CLASSES[d.cls],
      confidence: d.score,
      x: (d.box[0] + d.box[2]) / 2,
      y: (d.box[1] + d.box[3]) / 2,
      width: d.box[2] - d.box[0],
      height: d.box[3] - d.box[1],
    }))
    .sort((a, b) => a.x - b.x);

  return { cards: preds.map((p) => parseCard(p.class)), preds, backend };
}
