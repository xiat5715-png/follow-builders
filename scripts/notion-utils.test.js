import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findTitleProperty,
  makePageTitle,
  requireEnv,
  selectDataSource,
} from './notion-utils.js';

test('findTitleProperty detects a custom title column name', () => {
  assert.equal(findTitleProperty({ Digest: { type: 'title' } }), 'Digest');
});

test('selectDataSource returns the first data source', () => {
  assert.deepEqual(selectDataSource({ data_sources: [{ id: 'source-1' }] }), { id: 'source-1' });
});

test('makePageTitle uses the daily digest format', () => {
  assert.equal(makePageTitle('2026-06-14'), 'AI Builders Digest - 2026-06-14');
});

test('requireEnv reports all missing secrets', () => {
  assert.throws(
    () => requireEnv({ NOTION_TOKEN: '' }, ['NOTION_TOKEN', 'DEEPSEEK_API_KEY']),
    /NOTION_TOKEN, DEEPSEEK_API_KEY/,
  );
});
