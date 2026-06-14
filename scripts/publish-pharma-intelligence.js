#!/usr/bin/env node

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { Client } from '@notionhq/client';
import Parser from 'rss-parser';
import { findTitleProperty, requireEnv, selectDataSource } from './notion-utils.js';
import {
  beijingDate,
  compactItems,
  dedupeItems,
  estimateDeepSeekFlashCost,
  isRecent,
  keywordMatch,
  makePharmaPageTitle,
  stripHtml,
} from './pharma-intelligence-utils.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(SCRIPT_DIR, '..', 'config', 'pharma-intelligence-sources.json');
const parser = new Parser({ timeout: 20_000 });

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': 'pharma-ai4s-intelligence/1.0 (GitHub Actions)',
      Accept: 'application/json',
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

function googleNewsUrl(query, locale) {
  const settings = locale === 'zh'
    ? { hl: 'zh-CN', gl: 'CN', ceid: 'CN:zh-Hans' }
    : { hl: 'en-US', gl: 'US', ceid: 'US:en' };
  const params = new URLSearchParams({ q: `${query} when:2d`, ...settings });
  return `https://news.google.com/rss/search?${params}`;
}

async function collectNews(config, errors) {
  const jobs = config.newsQueries.map(async (source) => {
    try {
      const feed = await parser.parseURL(googleNewsUrl(source.query, source.locale));
      return (feed.items || [])
        .filter((item) => isRecent(item.isoDate || item.pubDate, config.lookbackHours))
        .slice(0, config.maxItemsPerQuery)
        .map((item) => ({
          title: stripHtml(item.title),
          summary: stripHtml(item.contentSnippet || item.content || item.summary || ''),
          url: item.link,
          publishedAt: item.isoDate || item.pubDate,
          source: item.creator || feed.title || 'Google News',
          sourceType: 'news',
          bucketHint: source.bucket,
          language: source.locale,
        }));
    } catch (error) {
      errors.push(`News query ${source.id}: ${error.message}`);
      return [];
    }
  });
  return (await Promise.all(jobs)).flat();
}

async function collectEuropePmc(config, errors) {
  const end = new Date();
  const start = new Date(end.getTime() - 21 * 24 * 3_600_000);
  const dateOnly = (value) => value.toISOString().slice(0, 10);
  const jobs = config.researchQueries.map(async (source) => {
    try {
      const datedQuery = `(${source.query}) AND FIRST_PDATE:[${dateOnly(start)} TO ${dateOnly(end)}]`;
      const params = new URLSearchParams({
        query: datedQuery,
        format: 'json',
        pageSize: '30',
        resultType: 'core',
      });
      const data = await fetchJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`);
      return (data.resultList?.result || [])
        .filter((item) => isRecent(item.firstPublicationDate || item.firstIndexDate, 24 * 21))
        .slice(0, 10)
        .map((item) => ({
          title: item.title,
          summary: item.abstractText || `${item.journalTitle || ''} ${item.authorString || ''}`,
          url: item.doi
            ? `https://doi.org/${item.doi}`
            : `https://europepmc.org/article/${item.source || 'MED'}/${item.id}`,
          publishedAt: item.firstPublicationDate || item.firstIndexDate,
          source: item.journalTitle || 'Europe PMC',
          sourceType: item.pubTypeList?.pubType?.includes('preprint') ? 'preprint' : 'research',
          bucketHint: 'ai4s-research',
          language: 'en',
          authors: item.authorString,
        }));
    } catch (error) {
      errors.push(`Europe PMC query ${source.id}: ${error.message}`);
      return [];
    }
  });
  return (await Promise.all(jobs)).flat();
}

async function collectBiorxiv(config, errors) {
  try {
    const data = await fetchJson('https://api.biorxiv.org/details/biorxiv/3d/0/json');
    return (data.collection || [])
      .filter((item) => keywordMatch(`${item.title} ${item.abstract}`, config.preprintKeywords))
      .map((item) => ({
        title: item.title,
        summary: item.abstract,
        url: `https://doi.org/${item.doi}`,
        publishedAt: item.date,
        source: `bioRxiv / ${item.category}`,
        sourceType: 'preprint',
        bucketHint: 'ai4s-research',
        language: 'en',
        authors: item.authors,
      }));
  } catch (error) {
    errors.push(`bioRxiv: ${error.message}`);
    return [];
  }
}

async function collectPodcasts(config, errors) {
  const jobs = config.podcasts.map(async (podcastName) => {
    try {
      const params = new URLSearchParams({ term: podcastName, media: 'podcast', entity: 'podcast', limit: '5' });
      const search = await fetchJson(`https://itunes.apple.com/search?${params}`);
      const match = (search.results || []).find((item) =>
        item.collectionName?.toLowerCase().includes(podcastName.toLowerCase()) ||
        podcastName.toLowerCase().includes(item.collectionName?.toLowerCase()),
      ) || search.results?.[0];
      if (!match?.feedUrl) return [];
      const feed = await parser.parseURL(match.feedUrl);
      return (feed.items || [])
        .filter((item) => isRecent(item.isoDate || item.pubDate, Math.max(config.lookbackHours, 168)))
        .slice(0, 1)
        .map((item) => ({
          title: item.title,
          summary: stripHtml(item.contentSnippet || item.content || item.summary || ''),
          url: item.link || item.guid,
          publishedAt: item.isoDate || item.pubDate,
          source: feed.title || podcastName,
          sourceType: 'podcast',
          bucketHint: 'people',
          language: feed.language || 'en',
        }));
    } catch (error) {
      errors.push(`Podcast ${podcastName}: ${error.message}`);
      return [];
    }
  });
  return (await Promise.all(jobs)).flat();
}

async function collectX(config, errors) {
  if (!process.env.X_BEARER_TOKEN) return [];
  const jobs = config.xQueries.map(async (query) => {
    try {
      const params = new URLSearchParams({
        query,
        max_results: '10',
        'tweet.fields': 'created_at,author_id',
        expansions: 'author_id',
        'user.fields': 'name,username,description',
      });
      const data = await fetchJson(`https://api.x.com/2/tweets/search/recent?${params}`, {
        headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
      });
      const users = new Map((data.includes?.users || []).map((user) => [user.id, user]));
      return (data.data || []).map((tweet) => {
        const author = users.get(tweet.author_id);
        return {
          title: `${author?.name || author?.username || 'X user'}: ${tweet.text.slice(0, 140)}`,
          summary: tweet.text,
          url: `https://x.com/${author?.username || 'i'}/status/${tweet.id}`,
          publishedAt: tweet.created_at,
          source: `${author?.name || 'X'} (${author?.username || 'unknown'} on X)`,
          sourceType: 'social',
          bucketHint: 'people',
          language: 'en',
        };
      });
    } catch (error) {
      errors.push(`X query: ${error.message}`);
      return [];
    }
  });
  return (await Promise.all(jobs)).flat();
}

async function collectCustomFeeds(config, errors) {
  let feeds = [...(config.customFeeds || [])];
  if (process.env.PHARMA_EXTRA_FEEDS_JSON) {
    try {
      feeds.push(...JSON.parse(process.env.PHARMA_EXTRA_FEEDS_JSON));
    } catch (error) {
      errors.push(`PHARMA_EXTRA_FEEDS_JSON: ${error.message}`);
    }
  }
  const jobs = feeds.map(async (source) => {
    try {
      const feed = await parser.parseURL(source.url);
      return (feed.items || [])
        .filter((item) => isRecent(item.isoDate || item.pubDate, config.lookbackHours))
        .slice(0, source.limit || 5)
        .map((item) => ({
          title: stripHtml(item.title),
          summary: stripHtml(item.contentSnippet || item.content || item.summary || ''),
          url: item.link,
          publishedAt: item.isoDate || item.pubDate,
          source: source.name || feed.title,
          sourceType: source.type || 'custom-rss',
          bucketHint: source.bucket || 'china',
          language: source.language || 'zh',
        }));
    } catch (error) {
      errors.push(`Custom feed ${source.name || source.url}: ${error.message}`);
      return [];
    }
  });
  return (await Promise.all(jobs)).flat();
}

function buildPrompt(date, items, collectionStats) {
  return `你是一名医药产业与 AI4S 情报分析师。请根据给定候选条目，生成 ${date} 的中文日报。

输出 Notion Markdown，标题必须为：# 医药与 AI4S 情报日报 - ${date}

固定结构：
## 今日要点
列出 5-8 条最重要变化，每条一句话。

## 国内医药产业
### 商业、交易与资本
### 研发、临床与监管

## 海外医药产业
### 商业、交易与资本
### 研发、临床与监管

## CRO / CDMO / 供应链

## 关键人物动向与观点

## AI4S / AI+生物医药
### AI制药与生物科技公司
### 基础模型与方法研究
### 单细胞、组学与虚拟细胞
### 衰老、生物年龄与生物钟
### 药物发现、蛋白设计与实验自动化

## 值得继续跟踪
列出 3-6 个未来可能产生后续进展的事项。

编辑规则：
- 只使用候选 JSON 中的信息，不补充记忆或常识，不猜测。
- 选择约 15-30 条高信号内容；没有可靠内容的栏目写“今日无高信号更新”，不要凑数。
- 每条用粗体短标题开头，随后写：发生了什么、为什么重要、主体属于大药企/CRO/CDMO/biotech/AI biotech 中哪类。
- 每条必须附原始 URL，并标注来源名、发布日期和来源类型。
- 同一事件有多条报道时合并，优先保留官方、监管机构、论文原文，其次是高质量媒体。
- 明确区分公司公告、媒体报道、论文/预印本和人物观点；预印本必须标“未经同行评议”。
- 不把相关性当因果，不把早期研究写成临床结论，不提供投资或医疗建议。
- 人名、公司、药物、模型等专有名词保留英文或官方中文名；技术术语可保留 AI、LLM、foundation model、single-cell 等。
- 对“药明康德”使用正确名称，不写成“药明德康”。
- 文末添加：数据窗口与覆盖说明，并说明 X 只有在配置 X_BEARER_TOKEN 时纳入、微信公众号依赖用户提供的合规 RSS/自定义 feed。

采集统计：${JSON.stringify(collectionStats)}

候选 JSON：
${JSON.stringify(items)}`;
}

async function findExistingPage(notion, dataSourceId, titleProperty, title) {
  const result = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: { property: titleProperty, title: { equals: title } },
    page_size: 1,
  });
  return result.results[0];
}

async function publishToNotion(markdown, title) {
  const databaseId = process.env.PHARMA_NOTION_DATABASE_ID || process.env.NOTION_DATABASE_ID;
  if (!databaseId) throw new Error('Missing PHARMA_NOTION_DATABASE_ID or NOTION_DATABASE_ID.');
  const notion = new Client({ auth: process.env.NOTION_TOKEN, notionVersion: '2026-03-11' });
  const database = await notion.databases.retrieve({ database_id: databaseId });
  const dataSource = selectDataSource(database);
  const schema = await notion.dataSources.retrieve({ data_source_id: dataSource.id });
  const titleProperty = findTitleProperty(schema.properties);
  const existing = await findExistingPage(notion, dataSource.id, titleProperty, title);
  if (existing && process.env.FORCE_NOTION_CREATE !== 'true') {
    console.log(`Notion page already exists: ${existing.url}`);
    return existing;
  }
  const page = await notion.pages.create({
    parent: { data_source_id: dataSource.id },
    properties: { [titleProperty]: { title: [{ text: { content: title } }] } },
    icon: { type: 'emoji', emoji: '💊' },
    markdown,
  });
  console.log(`Created Notion page: ${page.url}`);
  return page;
}

async function main() {
  const dryRun = process.env.PHARMA_DRY_RUN === 'true';
  if (!dryRun) requireEnv(process.env, ['DEEPSEEK_API_KEY', 'NOTION_TOKEN']);
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const errors = [];
  const [news, research, preprints, podcasts, xPosts, custom] = await Promise.all([
    collectNews(config, errors),
    collectEuropePmc(config, errors),
    collectBiorxiv(config, errors),
    collectPodcasts(config, errors),
    collectX(config, errors),
    collectCustomFeeds(config, errors),
  ]);

  const ordered = [...research, ...preprints, ...xPosts, ...podcasts, ...custom, ...news]
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const items = compactItems(dedupeItems(ordered), config.maxItemsForModel);
  if (items.length === 0) throw new Error(`No source items collected. ${errors.join(' | ')}`);

  const stats = {
    collected: { news: news.length, research: research.length, preprints: preprints.length, podcasts: podcasts.length, x: xPosts.length, custom: custom.length },
    sentToModel: items.length,
    lookbackHours: config.lookbackHours,
    nonFatalErrors: errors,
  };
  console.log(`Collected source items: ${JSON.stringify(stats.collected)}; model input: ${items.length}`);
  if (dryRun) {
    console.log(JSON.stringify({ stats, sample: items.slice(0, 10) }, null, 2));
    return;
  }

  const date = beijingDate();
  const title = makePharmaPageTitle(date);
  const deepseek = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  const response = await deepseek.chat.completions.create({
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: 'You are a rigorous pharmaceutical intelligence editor. Never invent facts or URLs.' },
      { role: 'user', content: buildPrompt(date, items, stats) },
    ],
    stream: false,
    extra_body: { thinking: { type: 'disabled' } },
  });
  const markdown = response.choices[0]?.message?.content?.trim();
  if (!markdown) throw new Error('DeepSeek returned an empty pharma digest.');
  const cost = estimateDeepSeekFlashCost(response.usage);
  console.log(`DeepSeek usage: ${JSON.stringify({
    inputTokens: cost.input,
    outputTokens: cost.output,
    cacheHitTokens: cost.cacheHit,
    cacheMissTokens: cost.cacheMiss,
    totalTokens: cost.total,
    estimatedUsd: Number(cost.usd.toFixed(6)),
  })}`);
  await publishToNotion(markdown, title);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
