#!/usr/bin/env node
// test/asar-read.mjs - read one file out of an Electron asar archive.
//
// `npx asar` is not reliably available offline, and the desktop app's bundled
// DSH is the version the plugin actually has to run under. The asar layout is
// simple: a pickle header holding a JSON directory tree, then the file bytes.
//
//   node test/asar-read.mjs <archive.asar> <list|find|cat> [pattern]
import fs from 'node:fs';
import path from 'node:path';

function readArchive(archive) {
  // The fd stays open: `read()` seeks into it on demand. The process exits
  // right after the CLI does its one job, so there is nothing to leak.
  const fd = fs.openSync(archive, 'r');
  // Layout (Electron/asar, observed on this archive):
  //   [0,4)   u32 = 4
  //   [4,8)   u32 = pickle size (header bytes, excluding the first 8)
  //   [8,12)  u32 = json size + 6
  //   [12,16) u32 = json size
  //   [16,)   JSON directory tree
  // File bytes start at 8 + pickleSize.
  //
  // Everything must be sliced by *byte* offset: decoding the whole archive as
  // a UTF-8 string and slicing that would index by character and misalign the
  // JSON the moment any multi-byte sequence appears before it.
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const pickleSize = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonSize);
  fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
  const json = JSON.parse(jsonBuf.toString('utf8'));
  const baseOffset = 8 + pickleSize;
  const files = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, path);
      else {
        // `unpacked` entries carry no offset: their bytes live in the sibling
        // `app.asar.unpacked/` directory instead of inside the archive.
        files.push({
          path,
          offset: entry.offset === undefined ? null : Number(entry.offset),
          size: Number(entry.size),
          unpacked: Boolean(entry.unpacked) || entry.offset === undefined,
        });
      }
    }
  };
  walk(json, '');
  return {
    files,
    close: () => fs.closeSync(fd),
    read(entry) {
      const buf = Buffer.alloc(entry.size);
      fs.readSync(fd, buf, 0, entry.size, baseOffset + entry.offset);
      return buf;
    },
  };
}

const [archive, command, pattern] = process.argv.slice(2);
if (!archive || !command) {
  console.error('usage: node test/asar-read.mjs <archive.asar> <list|find|cat> [pattern]');
  process.exit(2);
}
const { files, read } = readArchive(archive);

if (command === 'list') {
  console.log(files.length);
} else if (command === 'find') {
  const hits = files.filter((f) => f.path.includes(pattern)).slice(0, 40);
  for (const hit of hits) console.log(`${String(hit.size).padStart(9)}  ${hit.path}`);
} else if (command === 'cat') {
  const hit = files.find((f) => f.path === pattern) ?? files.find((f) => f.path.endsWith(pattern));
  if (!hit) {
    console.error(`not found: ${pattern}`);
    process.exit(1);
  }
  process.stdout.write(read(hit));
} else if (command === 'extract') {
  // extract <subtreePrefix> <destDir>
  const prefix = pattern;
  const dest = process.argv[5];
  if (!dest) {
    console.error('usage: node test/asar-read.mjs <archive> extract <subtreePrefix> <destDir>');
    process.exit(2);
  }
  const wanted = files.filter((f) => f.path === prefix || f.path.startsWith(`${prefix}/`));
  let written = 0;
  let bytes = 0;
  const skipped = [];
  for (const entry of wanted) {
    const rel = entry.path.slice(prefix.length).replace(/^\//, '');
    if (!rel) continue;
    if (entry.unpacked) {
      skipped.push(entry.path);
      continue;
    }
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, read(entry));
    written += 1;
    bytes += entry.size;
  }
  console.log(`extracted ${written} files (${(bytes / 1048576).toFixed(1)} MB) into ${dest}`);
  if (skipped.length) {
    console.log(`skipped ${skipped.length} unpacked entries (bytes live in app.asar.unpacked/)`);
    for (const s of skipped.slice(0, 5)) console.log(`  - ${s}`);
  }
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
