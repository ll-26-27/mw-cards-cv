// Copies the onnxruntime-web runtime into public/ort and downloads the card model into
// public/models. Runs on `npm install` (postinstall); safe to re-run.
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const MODEL_URL = "https://huggingface.co/sroot/lgd-cards-gen3/resolve/main/model.onnx";

const ortSrc = join(root, "node_modules/onnxruntime-web/dist");
const ortDst = join(root, "public/ort");
await mkdir(ortDst, { recursive: true });
for (const f of await readdir(ortSrc)) {
  if (f === "ort.min.js" || /^ort-wasm.*\.(wasm|mjs)$/.test(f)) {
    await copyFile(join(ortSrc, f), join(ortDst, f));
  }
}

const modelPath = join(root, "public/models/cards.onnx");
await mkdir(join(root, "public/models"), { recursive: true });
const exists = await stat(modelPath).then((s) => s.size > 0, () => false);
if (!exists) {
  console.log(`downloading card model from ${MODEL_URL}`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  await writeFile(modelPath, Buffer.from(await res.arrayBuffer()));
}
console.log("ort runtime + card model ready in public/");
