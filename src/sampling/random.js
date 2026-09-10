import { createHmac, randomBytes } from "node:crypto";

/**
 * Deterministic, seed-reproducible randomness.
 *
 * Math.random() cannot be used here: a sampling batch must be reproducible from its
 * stored seed, so the generator is HMAC-SHA256 in counter mode. The same seed yields
 * the same sequence on any machine, Node version or platform.
 */
export function createSeededRandom(seed) {
  const key = String(seed);
  let counter = 0;
  let block = Buffer.alloc(0);
  let offset = 0;

  return function next() {
    if (offset + 4 > block.length) {
      block = createHmac("sha256", key).update(String(counter)).digest();
      counter += 1;
      offset = 0;
    }
    const value = block.readUInt32BE(offset);
    offset += 4;
    return value / 4294967296;
  };
}

export function shuffle(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [copy[index], copy[swapWith]] = [copy[swapWith], copy[index]];
  }
  return copy;
}

export function generateSeed() {
  return `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4).toString("hex")}`;
}
