"use client";

import { useState } from "react";
import Camera, { CardTile } from "./Camera";
import { Card, detect } from "./detector";

function Upload() {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [output, setOutput] = useState<string>("");

  const handleFile = async (file: File) => {
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    setCards(null);
    setOutput("detecting…");
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const { cards } = await detect(img, img.naturalWidth, img.naturalHeight);
      setCards(cards);
      setOutput(JSON.stringify(cards, null, 2));
    } catch (e) {
      setOutput(`error: ${(e as Error).message}`);
    }
  };

  return (
    <div className="upload">
      <label
        className="drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
      >
        drop an image or click to choose
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
      </label>

      {imgUrl && <img src={imgUrl} alt="" />}
      {cards && (
        <div className="cards">
          {cards.map((c, i) => <CardTile key={`${c.raw}-${i}`} card={c} />)}
        </div>
      )}
      {output && <pre>{output}</pre>}
    </div>
  );
}

export default function Page() {
  const [mode, setMode] = useState<"camera" | "upload">("camera");

  return (
    <main>
      <nav className="tabs">
        <button className={mode === "camera" ? "on" : ""} onClick={() => setMode("camera")}>
          live camera
        </button>
        <button className={mode === "upload" ? "on" : ""} onClick={() => setMode("upload")}>
          upload image
        </button>
      </nav>
      {mode === "camera" ? <Camera /> : <Upload />}
    </main>
  );
}
