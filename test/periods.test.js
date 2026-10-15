import test from 'node:test';
import assert from 'node:assert/strict';
import { periodFor } from '../server/core/periods.js';

const m = (reset_day) => ({ period: 'monthly', reset_day });

test('monthly on the 1st: first and last day belong to the same period', () => {
  assert.deepEqual(periodFor(m(1), '2026-10-01'), { start: '2026-10-01', end: '2026-10-31', resetsOn: '2026-11-01' });
  assert.deepEqual(periodFor(m(1), '2026-10-31'), { start: '2026-10-01', end: '2026-10-31', resetsOn: '2026-11-01' });
  assert.equal(periodFor(m(1), '2026-11-01').start, '2026-11-01');
});

test('monthly crosses the year boundary', () => {
  assert.deepEqual(periodFor(m(1), '2026-12-31'), { start: '2026-12-01', end: '2026-12-31', resetsOn: '2027-01-01' });
  assert.deepEqual(periodFor(m(15), '2027-01-03'), { start: '2026-12-15', end: '2027-01-14', resetsOn: '2027-01-15' });
});

test('monthly with a mid-month reset day (payday on the 15th)', () => {
  assert.deepEqual(periodFor(m(15), '2026-10-14'), { start: '2026-09-15', end: '2026-10-14', resetsOn: '2026-10-15' });
  assert.deepEqual(periodFor(m(15), '2026-10-15'), { start: '2026-10-15', end: '2026-11-14', resetsOn: '2026-11-15' });
});

test('reset day 31 clamps to short months, including leap years', () => {
  assert.deepEqual(periodFor(m(31), '2026-02-27'), { start: '2026-01-31', end: '2026-02-27', resetsOn: '2026-02-28' });
  assert.deepEqual(periodFor(m(31), '2026-02-28'), { start: '2026-02-28', end: '2026-03-30', resetsOn: '2026-03-31' });
  assert.deepEqual(periodFor(m(31), '2028-02-28'), { start: '2028-01-31', end: '2028-02-28', resetsOn: '2028-02-29' });
  assert.equal(periodFor(m(31), '2028-02-29').start, '2028-02-29');
  assert.deepEqual(periodFor(m(30), '2026-04-30'), { start: '2026-04-30', end: '2026-05-29', resetsOn: '2026-05-30' });
});

test('weekly resets on the chosen weekday', () => {
  const monday = { period: 'weekly', reset_weekday: 1 };
  // 2026-10-12 is a Monday
  assert.deepEqual(periodFor(monday, '2026-10-12'), { start: '2026-10-12', end: '2026-10-18', resetsOn: '2026-10-19' });
  assert.deepEqual(periodFor(monday, '2026-10-18'), { start: '2026-10-12', end: '2026-10-18', resetsOn: '2026-10-19' });
  assert.equal(periodFor(monday, '2026-10-19').start, '2026-10-19');
  const sunday = { period: 'weekly', reset_weekday: 0 };
  assert.equal(periodFor(sunday, '2026-10-17').start, '2026-10-11');
  // Week spanning a month and year boundary
  assert.deepEqual(periodFor(sunday, '2027-01-01'), { start: '2026-12-27', end: '2027-01-02', resetsOn: '2027-01-03' });
});

test('weekly is unaffected by the daylight-saving change (Nov 1, 2026)', () => {
  const sunday = { period: 'weekly', reset_weekday: 0 };
  assert.deepEqual(periodFor(sunday, '2026-11-03'), { start: '2026-11-01', end: '2026-11-07', resetsOn: '2026-11-08' });
  assert.deepEqual(periodFor(sunday, '2026-10-31'), { start: '2026-10-25', end: '2026-10-31', resetsOn: '2026-11-01' });
});

test('every two weeks from an anchor, before and after the anchor', () => {
  const b = { period: 'biweekly', anchor_date: '2026-10-02' };
  assert.deepEqual(periodFor(b, '2026-10-02'), { start: '2026-10-02', end: '2026-10-15', resetsOn: '2026-10-16' });
  assert.deepEqual(periodFor(b, '2026-10-15'), { start: '2026-10-02', end: '2026-10-15', resetsOn: '2026-10-16' });
  assert.equal(periodFor(b, '2026-10-16').start, '2026-10-16');
  assert.deepEqual(periodFor(b, '2026-10-01'), { start: '2026-09-18', end: '2026-10-01', resetsOn: '2026-10-02' });
});
