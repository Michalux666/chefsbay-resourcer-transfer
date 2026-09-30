'use strict';
// Child process for the streaming/memory test: packs, authenticates and extracts a large synthetic file
// and reports how much the peak resident set grew beyond what key derivation alone needed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const F = require('../../tools/lib/bundle-format.js');

const dir = process.argv[2];
const megabytes = Number(process.argv[3] || 60);
const MiB = 1024 * 1024;

function maxRssMb() {
  return process.resourceUsage().maxRSS / 1024;
}

const big = path.join(dir, 'big.bin');
const fd = fs.openSync(big, 'w');
const piece = Buffer.allocUnsafe(MiB);
for (let i = 0; i < megabytes; i += 1) {
  crypto.randomFillSync(piece);
  fs.writeSync(fd, piece);
}
fs.closeSync(fd);
const srcHash = F.hashFile(big);

const header = F.newHeader({ logN: 15 });
const key = F.deriveKey('a streaming test passphrase', header);
if (global.gc) global.gc();
const baseline = maxRssMb();

const out = path.join(dir, 'big.enc');
const written = F.writeBundle(out, {
  header, key,
  entries: [{ path: 'config/big.json', sourcePath: big }],
  manifestBase: F.newManifestBase({ sourceHost: 'stream-test', warnings: [] }),
});

const scanned = F.scanBundle(out, { key });

const extracted = path.join(dir, 'big.out');
const outFd = fs.openSync(extracted, 'w');
F.scanBundle(out, { key }, {
  sink() {
    return { write(b) { F.writeAll(outFd, b); }, end() { fs.closeSync(outFd); }, abort() {} };
  },
});
const outHash = F.hashFile(extracted);

const after = maxRssMb();
process.stdout.write(JSON.stringify({
  baselineMb: Math.round(baseline),
  afterMb: Math.round(after),
  growthMb: Math.round(after - baseline),
  fileMb: megabytes,
  bundleBytes: fs.statSync(out).size,
  chunks: written.chunks,
  scannedChunks: scanned.chunks,
  identical: srcHash.sha256 === outHash.sha256 && srcHash.size === outHash.size,
  sizeMatches: fs.statSync(out).size > megabytes * MiB,
}));
