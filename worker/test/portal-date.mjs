import assert from 'node:assert/strict';
import { currentSermonDate_ } from '../src/khatib-portal.js';

for (const [instant, expected] of [
  ['2026-10-21T10:00:00Z', '2026-10-23'],
  ['2026-10-22T20:59:59Z', '2026-10-23'],
  ['2026-10-22T21:00:00Z', '2026-10-23'],
  ['2026-10-23T20:59:59Z', '2026-10-23'],
  ['2026-10-23T21:00:00Z', '2026-10-30'],
  ['2026-12-31T22:00:00Z', '2027-01-01'],
]) {
  assert.equal(currentSermonDate_(new Date(instant)), expected, instant);
}
console.log('PASS: current sermon follows Cairo dates including Friday rollover and year boundary');
