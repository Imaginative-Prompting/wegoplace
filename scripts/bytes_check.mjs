#!/usr/bin/env node
// A number of bytes in words (public/js/shared/bytes.js), with no browser: the one spelling every
// meter and sentence uses, the app's and the server's.   node scripts/bytes_check.mjs
import { formatBytes } from "../public/js/shared/bytes.js";

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}   -> ${detail}`); } };
const KB = 1024, MB = 1024 ** 2, GB = 1024 ** 3;
const cases = [
  [0, "0 MB", "nothing"], [1, "1 KB", "a byte is a KB, never 0"], [12 * KB, "12 KB", "KB"], [4.5 * MB, "4.5 MB", "one decimal under 10"],
  [610 * MB, "610 MB", "whole over 10"], [GB, "1 GB", "the free limit"], [1.5 * GB, "1.5 GB", "over it"],
  // The edges: a figure that would round to 1024 is one of the next unit (Your trips said "1024 MB left").
  [GB - 88 * KB, "1 GB", "88 KB short of 1 GB is 1 GB left, not 1024 MB"], [GB - 0.6 * MB, "1023 MB", "0.6 MB short is 1023.4 MB, which reads 1023 MB"],
  [GB - 0.4 * MB, "1 GB", "0.4 MB short is 1 GB too (1023.6 MB rounds to 1024)"], [1023 * MB, "1023 MB", "a whole MB short is still MB"],
  [MB - 100, "1 MB", "100 bytes short of 1 MB is 1 MB, not 1024 KB"], [1023 * KB, "1023 KB", "a whole KB short is still KB"],
];
for (const [n, want, why] of cases) check(`${why}: ${n} bytes → ${want}`, formatBytes(n) === want, formatBytes(n));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
