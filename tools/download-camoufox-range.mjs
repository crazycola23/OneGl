import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const [url, start, end, output] = process.argv.slice(2);
if (!url || !start || !end || !output) {
  throw new Error("usage: download-camoufox-range.mjs <url> <start> <end> <output>");
}

const response = await fetch(url, {
  headers: {
    Range: `bytes=${start}-${end}`,
    "Accept-Encoding": "identity",
  },
  signal: AbortSignal.timeout(900_000),
});
if (response.status !== 206) {
  throw new Error(`Camoufox asset ignored range request: HTTP ${response.status}`);
}
if (!response.body) throw new Error("Camoufox asset response had no body");
await pipeline(Readable.fromWeb(response.body), createWriteStream(output));
