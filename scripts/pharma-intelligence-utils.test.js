import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beijingDate,
  dedupeItems,
  estimateDeepSeekFlashCost,
  isRecent,
  lookupJournalMetric,
  makePharmaPageTitle,
  normalizeTitle,
  normalizeDoi,
  stripHtml,
} from './pharma-intelligence-utils.js';

test('stripHtml turns feed markup into plain text', () => {
  assert.equal(stripHtml('<p>AI &amp; biology</p>'), 'AI & biology');
});

test('normalizeTitle removes a trailing publisher label', () => {
  assert.equal(normalizeTitle('Company reports trial data - Reuters'), 'company reports trial data');
});

test('dedupeItems removes repeated headlines', () => {
  assert.equal(dedupeItems([
    { title: 'New drug approved - Reuters', url: 'a' },
    { title: 'New drug approved - Bloomberg', url: 'b' },
  ]).length, 1);
});

test('dedupeItems removes near-duplicate Chinese clinical headlines', () => {
  assert.equal(dedupeItems([
    { title: '百利天恒：BL-M14D1联合用药临床试验获批准', url: 'a' },
    { title: '百利天恒最新公告：BL-M14D1联合用药治疗肺癌临床试验获得批准', url: 'b' },
  ]).length, 1);
});

test('isRecent respects the lookback window', () => {
  const now = new Date('2026-06-14T12:00:00Z');
  assert.equal(isRecent('2026-06-13T12:00:00Z', 48, now), true);
  assert.equal(isRecent('2026-06-10T12:00:00Z', 48, now), false);
});

test('pharma title and Beijing date are deterministic', () => {
  assert.equal(beijingDate(new Date('2026-06-14T00:30:00Z')), '2026-06-14');
  assert.equal(makePharmaPageTitle('2026-06-14'), '医药与 AI4S 情报日报 - 2026-06-14');
});

test('DeepSeek cost estimate separates cache hits and misses', () => {
  const cost = estimateDeepSeekFlashCost({
    prompt_tokens: 100000,
    prompt_cache_hit_tokens: 20000,
    completion_tokens: 5000,
    total_tokens: 105000,
  });
  assert.equal(cost.cacheMiss, 80000);
  assert.equal(cost.total, 105000);
  assert.ok(Math.abs(cost.usd - 0.012656) < 1e-9);
});

test('DOIs and licensed journal metrics are normalized without guessing', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1234/ABC'), '10.1234/ABC');
  const metrics = { journals: { '1234-5678': { value: 12.3, year: 2025, source: 'JCR' } } };
  assert.deepEqual(
    lookupJournalMetric(metrics, { journal: 'Example Journal', issn: ['1234-5678'] }),
    { value: 12.3, year: 2025, source: 'JCR' },
  );
  assert.equal(lookupJournalMetric(metrics, { journal: 'Unknown' }), null);
});
