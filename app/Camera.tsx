"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Pred, detect, loadDetector } from "./detector";

const DEVICE_KEY = "cards-cv:cameraId";

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
      saved = localStorage.getItem(DEVICE_KEY) ?? "";
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

  const detectFrame = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const t0 = performance.now();
    const { cards, preds, backend } = await detect(video, video.videoWidth, video.videoHeight);
    const ms = Math.round(performance.now() - t0);
    setStatus(`${cards.length} card(s) · ${ms} ms · ${backend}`);
    setCards(cards);
    setRawJson(JSON.stringify(cards, null, 2));
    drawBoxes(preds);
  };

  // One detection at a time; wait intervalMs between the end of one and the next.
  const loop = async () => {
    while (runningRef.current) {
      try {
        await detectFrame();
      } catch (e) {
        setStatus((e as Error).message);
      }
      // Always yield at least a frame so the video and UI stay smooth.
      await new Promise((r) =>
        intervalMsRef.current ? setTimeout(r, intervalMsRef.current) : requestAnimationFrame(r),
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
        <button onClick={() => detectFrame().catch((e) => setStatus(e.message))} disabled={running}>
          snapshot
        </button>
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
