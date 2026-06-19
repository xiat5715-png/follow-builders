import { createHash } from 'node:crypto';

export function beijingDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function makePharmaPageTitle(date) {
  return `医药与 AI4S 情报日报 - ${date}`;
}

export function stripHtml(value = '') {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTitle(value = '') {
  return stripHtml(value)
    .toLowerCase()
    .replace(/\s+-\s+[^-]{2,80}$/u, '')
    .replace(/[（(][^）)]{0,50}[）)]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function titleTokens(value) {
  const normalized = normalizeTitle(value);
  const latin = normalized.split(/\s+/).filter((token) => token.length > 2);
  const cjk = [...normalized.replace(/[\x00-\x7F]/g, '')];
  return new Set([...latin, ...cjk]);
}

function titleSimilarity(left, right) {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.min(a.size, b.size);
}

export function stableId(item) {
  return createHash('sha1')
    .update(`${normalizeTitle(item.title)}|${item.url || ''}`)
    .digest('hex')
    .slice(0, 16);
}

export function isRecent(dateValue, lookbackHours, now = new Date()) {
  if (!dateValue) return true;
  const timestamp = new Date(dateValue).getTime();
  if (!Number.isFinite(timestamp)) return true;
  const age = now.getTime() - timestamp;
  return age >= -3_600_000 && age <= lookbackHours * 3_600_000;
}

export function dedupeItems(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = normalizeTitle(item.title);
    const nearDuplicate = output.some((existing) => titleSimilarity(existing.title, item.title) >= 0.82);
    if (!key || seen.has(key) || nearDuplicate) continue;
    seen.add(key);
    output.push({ ...item, id: item.id || stableId(item) });
  }
  return output;
}

export function compactItems(items, maxItems = 120) {
  return items.slice(0, maxItems).map((item) => ({
    id: item.id,
    title: item.title,
    summary: stripHtml(item.summary || '').slice(0, 1400),
    url: item.url,
    publishedAt: item.publishedAt,
    source: item.source,
    sourceType: item.sourceType,
    fetcher: item.fetcher,
    bucketHint: item.bucketHint,
    language: item.language,
    authors: item.authors,
    doi: item.doi,
    journal: item.journal,
    publicationStatus: item.publicationStatus,
    journalMetrics: item.journalMetrics,
    articleCitations: item.articleCitations,
    correspondingAuthor: item.correspondingAuthor,
    correspondingInstitution: item.correspondingInstitution,
    authorProfile: item.authorProfile,
    metadata: item.metadata,
  }));
}

export function normalizeDoi(value = '') {
  return value
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
}

export function lookupJournalMetric(metrics, { journal, issn = [] } = {}) {
  const journals = metrics?.journals || {};
  const candidates = [journal, ...issn]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());
  for (const key of candidates) {
    if (journals[key]) return journals[key];
  }
  return null;
}

export function estimateDeepSeekFlashCost(usage = {}) {
  const input = usage.prompt_tokens || 0;
  const cacheHit = Math.min(usage.prompt_cache_hit_tokens || 0, input);
  const cacheMiss = Math.max(input - cacheHit, 0);
  const output = usage.completion_tokens || 0;
  const usd = (cacheHit * 0.0028 + cacheMiss * 0.14 + output * 0.28) / 1_000_000;
  return { input, output, cacheHit, cacheMiss, total: usage.total_tokens || input + output, usd };
}

export function keywordMatch(text, keywords) {
  const haystack = text.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}
