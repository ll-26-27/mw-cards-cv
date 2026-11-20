"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Pred, detect, loadDetector } from "./detector";
import type { PublishedCard } from "./lib/hub";
import { Stabilizer } from "./stable";

const DEVICE_KEY = "cards-cv:cameraId";
// While detecting, the feed re-posts at least this often so the server knows it is alive.
const HEARTBEAT_MS = 2000;

const SUIT_SYMBOL: Record<string, string> = {
  clubs: "♣", diamonds: "♦", hearts: "♥", spades: "♠",
};

export function CardTile({ card }: { card: Card }) {
  const sym = SUIT_SYMBOL[card.suit];
  if (!sym) return <div className="card unknown">{card.raw}</div>;
  const red = card.suit === "hearts" || card.suit === "diamonds";
  return (
    <div className={`card${red ? " red" : ""}`} title={card.raw}>
      <span className="corner">{card.rank}<br />{sym}</span>
      <span className="pip">{sym}</span>
      <span className="corner flip">{card.rank}<br />{sym}</span>
    </div>
  );
}

export default function Camera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(false);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [intervalMs, setIntervalMs] = useState(0);
  const [cards, setCards] = useState<Card[]>([]);
  const [rawJson, setRawJson] = useState("");
  const [status, setStatus] = useState("");

  // The name this camera publishes under. Each camera gets its own window with its own
  // name (open /?feed=dealer, /?feed=player-1, ...); the overlay app groups cards by it.
  const [feed, setFeed] = useState("table");
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const [onAir, setOnAir] = useState<PublishedCard[]>([]);
  const [publishError, setPublishError] = useState("");
  const stabilizer = useRef(new Stabilizer());
  const lastSent = useRef({ signature: "", at: 0 });

  useEffect(() => {
    const named = new URLSearchParams(window.location.search).get("feed")?.trim();
    if (named) setFeed(named);
  }, []);

  const renameFeed = (name: string) => {
    if (runningRef.current) return;
    setFeed(name);
    const url = new URL(window.location.href);
    url.searchParams.set("feed", name);
    window.history.replaceState(null, "", url);
  };

  const publish = async (cards: PublishedCard[]) => {
    const signature = cards.map((c) => c.code).join(",");
    const now = Date.now();
    if (signature === lastSent.current.signature && now - lastSent.current.at < HEARTBEAT_MS) return;
    lastSent.current = { signature, at: now };
    setOnAir(cards);
    try {
      const res = await fetch("/api/cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feed: feedRef.current.trim() || "table", cards }),
      });
      if (!res.ok) throw new Error(`publish failed: ${res.status}`);
      setPublishError("");
    } catch (e) {
      setPublishError((e as Error).message);
    }
  };

  const unpublish = () => {
    stabilizer.current.reset();
    lastSent.current = { signature: "", at: 0 };
    setOnAir([]);
    const name = encodeURIComponent(feedRef.current.trim() || "table");
    fetch(`/api/cards?feed=${name}`, { method: "DELETE", keepalive: true }).catch(() => {});
  };

  // Labels are only populated after camera permission is granted, so ask once up front.
  const refreshDevices = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      setStatus(`camera permission denied: ${(e as Error).message}`);
      return;
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    const cams = all.filter((d) => d.kind === "videoinput");
    setDevices(cams);
    let saved = "";
    try {
      saved = localStorage.getItem(`${DEVICE_KEY}:${feedRef.current}`) ?? localStorage.getItem(DEVICE_KEY) ?? "";
    } catch {}
    setDeviceId((cur) =>
      cams.some((c) => c.deviceId === cur)
        ? cur
        : cams.find((c) => c.deviceId === saved)?.deviceId ?? cams[0]?.deviceId ?? "",
    );
  }, []);

  // Start fetching the model right away so the first detection isn't slow.
  useEffect(() => {
    setStatus("loading model…");
    loadDetector()
      .then(({ backend }) => setStatus(`model ready (${backend})`))
      .catch((e) => setStatus(`model failed to load: ${(e as Error).message}`));
  }, []);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  // (Re)open the stream whenever the selected camera changes.
  useEffect(() => {
    if (!deviceId) return;
    try {
      localStorage.setItem(DEVICE_KEY, deviceId);
      localStorage.setItem(`${DEVICE_KEY}:${feedRef.current}`, deviceId);
    } catch {}
    let cancelled = false;
    (async () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: deviceId },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (e) {
        setStatus(`could not open camera: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  useEffect(
    () => () => {
      runningRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const drawBoxes = (preds: Pred[]) => {
    const video = videoRef.current;
    const canvas = overlayRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const lw = Math.max(2, canvas.width / 400);
    ctx.lineWidth = lw;
    ctx.font = `${Math.round(lw * 9)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "bottom";
    for (const p of preds) {
      const x = p.x - p.width / 2;
      const y = p.y - p.height / 2;
      const w = p.width;
      const h = p.height;
      ctx.strokeStyle = "#4c82ff";
      ctx.strokeRect(x, y, w, h);
      const label = `${p.class} ${Math.round(p.confidence * 100)}%`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "#4c82ff";
      ctx.fillRect(x, y - lw * 12, tw + lw * 4, lw * 12);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x + lw * 2, y - lw);
    }
  };

  // `trust` publishes this one frame as it stands (snapshot, or a slow interval where waiting
  // several frames would take seconds); otherwise cards are steadied across frames first.
  const detectFrame = async (trust = false, live = false) => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const t0 = performance.now();
    const { cards, preds, backend } = await detect(video, video.videoWidth, video.videoHeight);
    const ms = Math.round(performance.now() - t0);
    setStatus(`${cards.length} card(s) · ${ms} ms · ${backend}`);
    setCards(cards);
    setRawJson(JSON.stringify(cards, null, 2));
    drawBoxes(preds);
    // Stop was pressed while this frame was in the model; the feed is already cleared.
    if (live && !runningRef.current) return;
    const stable = trust
      ? stabilizer.current.update(preds, video.videoWidth, video.videoHeight, 1, 1)
      : stabilizer.current.update(preds, video.videoWidth, video.videoHeight);
    await publish(stable);
  };

  // One detection at a time; wait intervalMs between the end of one and the next.
  const loop = async () => {
    while (runningRef.current) {
      try {
        await detectFrame(intervalMsRef.current >= 500, true);
      } catch (e) {
        setStatus((e as Error).message);
      }
      // Always yield at least a frame so the video and UI stay smooth. A hidden window gets
      // no animation frames, so fall back to a timer there and keep detecting.
      await new Promise((r) =>
        intervalMsRef.current
          ? setTimeout(r, intervalMsRef.current)
          : document.hidden
            ? setTimeout(r, 0)
            : requestAnimationFrame(r),
      );
    }
  };
  const intervalMsRef = useRef(intervalMs);
  intervalMsRef.current = intervalMs;

  const start = () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    loop();
  };
  const stop = () => {
    runningRef.current = false;
    setRunning(false);
    unpublish();
  };

  return (
    <div>
      <div className="controls">
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
          {devices.length === 0 && <option value="">no cameras found</option>}
          {devices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `camera ${i + 1}`}
            </option>
          ))}
        </select>
        <label>
          every
          <select value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))}>
            <option value={0}>as fast as possible</option>
            <option value={500}>0.5s</option>
            <option value={1000}>1s</option>
            <option value={2000}>2s</option>
            <option value={5000}>5s</option>
          </select>
        </label>
        {running ? (
          <button onClick={stop}>stop</button>
        ) : (
          <button onClick={start} disabled={!deviceId}>
            start detecting
          </button>
        )}
        <button onClick={() => detectFrame(true).catch((e) => setStatus(e.message))} disabled={running}>
          snapshot
        </button>
        <label>
          feed
          <input
            className="feed"
            value={feed}
            disabled={running}
            onChange={(e) => renameFeed(e.target.value)}
            spellCheck={false}
          />
        </label>
      </div>

      <div className="live">
        <div className="stage">
          <video ref={videoRef} autoPlay playsInline muted />
          <canvas ref={overlayRef} />
          {running && <span className="badge">● live</span>}
        </div>

        <aside className="hand">
          <h2>cards in view</h2>
          {status && <p className="status">{status}</p>}
          <div className="cards">
            {cards.length === 0 ? (
              <p className="empty">{running ? "no cards detected" : "press start or snapshot"}</p>
            ) : (
              cards.map((c, i) => <CardTile key={`${c.raw}-${i}`} card={c} />)
            )}
          </div>
          <p className="status">
            sent to overlay as “{feed.trim() || "table"}”:{" "}
            {onAir.length ? onAir.map((c) => c.code).join(" ") : "nothing"}
          </p>
          {publishError && <p className="status error">{publishError}</p>}
          {rawJson && (
            <details>
              <summary>json</summary>
              <pre>{rawJson}</pre>
            </details>
          )}
        </aside>
      </div>
    </div>
  );
}
