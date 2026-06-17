#!/usr/bin/env node

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { Client } from '@notionhq/client';
import Parser from 'rss-parser';
import { load } from 'cheerio';
import {
  compactFeeds,
  findTitleProperty,
  makePageTitle,
  requireEnv,
  selectDataSource,
} from './notion-utils.js';

const FEED_X_URL = process.env.FEED_X_URL ||
  `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY || 'zarazhangrui/follow-builders'}/main/feed-x.json`;
const FEED_PODCASTS_URL = process.env.FEED_PODCASTS_URL ||
  `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY || 'zarazhangrui/follow-builders'}/main/feed-podcasts.json`;
const FEED_BLOGS_URL = process.env.FEED_BLOGS_URL ||
  `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY || 'zarazhangrui/follow-builders'}/main/feed-blogs.json`;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WATCHLIST_CONFIG_PATH = join(SCRIPT_DIR, '..', 'config', 'ai-watchlist-sources.json');
const WATCHLIST_USER_AGENT = 'Mozilla/5.0 (compatible; ai-watchlist-digest/1.0)';

const rssParser = new Parser({
  timeout: 20000,
  headers: { 'User-Agent': WATCHLIST_USER_AGENT },
});

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(20_000),
    headers: {
      'User-Agent': WATCHLIST_USER_AGENT,
      Accept: 'application/rss+xml, application/xml, text/xml, text/html, application/json, */*',
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

function stripHtml(value = '') {
  return load(`<main>${value}</main>`)('main').text().replace(/\s+/g, ' ').trim();
}

function compactText(value = '', maxLength = 1200) {
  const text = stripHtml(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function beijingDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function isRecentDate(value, lookbackDays, now = new Date()) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return true;
  return parsed.getTime() >= now.getTime() - lookbackDays * 24 * 60 * 60 * 1000;
}

async function loadWatchlistConfig(errors) {
  try {
    return JSON.parse(await readFile(WATCHLIST_CONFIG_PATH, 'utf8'));
  } catch (error) {
    errors.push(`AI watchlist config: ${error.message}`);
    return { enabled: false };
  }
}

async function collectWatchlistPodcasts(config, errors) {
  const items = [];
  const maxItems = config.maxItemsPerSource || 3;
  const lookbackDays = config.lookbackDays || 21;
  for (const source of config.podcastFeeds || []) {
    let collected = [];
    try {
      const xml = await fetchText(source.feedUrl);
      const feed = await rssParser.parseString(xml);
      collected = (feed.items || [])
        .filter((item) => isRecentDate(item.isoDate || item.pubDate, lookbackDays))
        .slice(0, maxItems)
        .map((item) => ({
          source: source.name,
          sourceType: 'watchlist-podcast',
          title: stripHtml(item.title || 'Untitled'),
          url: item.link || item.guid || source.homepage,
          publishedAt: item.isoDate || item.pubDate || '',
          summary: compactText(item.contentSnippet || item.itunes?.summary || item.content || item.summary || '', 1200),
        }));
    } catch (error) {
      if (!source.applePodcastId) {
        errors.push(`${source.name}: ${error.message}`);
      }
    }
    if (collected.length === 0 && source.applePodcastId) {
      try {
        const url = new URL('https://itunes.apple.com/lookup');
        url.searchParams.set('id', source.applePodcastId);
        url.searchParams.set('entity', 'podcastEpisode');
        url.searchParams.set('limit', String(maxItems));
        const payload = JSON.parse(await fetchText(url.toString(), {
          headers: { Accept: 'application/json, text/plain, */*' },
        }));
        collected = (payload.results || [])
          .filter((item) => item.wrapperType === 'podcastEpisode')
          .filter((item) => isRecentDate(item.releaseDate, lookbackDays))
          .slice(0, maxItems)
          .map((item) => ({
            source: source.name,
            sourceType: 'watchlist-podcast',
            title: stripHtml(item.trackName || 'Untitled'),
            url: item.trackViewUrl || source.homepage,
            publishedAt: item.releaseDate || '',
            summary: compactText(item.description || '', 1200),
          }));
      } catch (fallbackError) {
        errors.push(`${source.name}: ${fallbackError.message}`);
      }
    }
    items.push(...collected);
  }
  return items;
}

async function collectLatePost(config, errors) {
  const settings = config.latePost;
  if (!settings?.enabled) return [];
  try {
    const params = new URLSearchParams({ page: '1', limit: String(config.maxItemsPerSource || 3) });
    const response = await fetch(settings.apiUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'User-Agent': WATCHLIST_USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/plain, */*',
      },
      body: params,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return (payload.data || []).slice(0, config.maxItemsPerSource || 3).map((item) => ({
      source: settings.name,
      sourceType: 'watchlist-article',
      title: stripHtml(item.title || 'Untitled'),
      url: new URL(item.detail_url || '/', settings.homepage).toString(),
      publishedAt: item.release_time || '',
      summary: compactText(item.abstract || item.intro || '', 800),
    }));
  } catch (error) {
    errors.push(`${settings.name}: ${error.message}`);
    return [];
  }
}

async function collectWechatSearches(config, errors, notes) {
  const items = [];
  for (const source of config.wechatSearches || []) {
    try {
      const url = new URL(source.searchUrl || 'https://weixin.sogou.com/weixin');
      url.searchParams.set('type', '2');
      url.searchParams.set('query', source.query);
      const html = await fetchText(url.toString(), {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      const $ = load(html);
      const candidates = [];
      $('ul.news-list > li').each((_, element) => {
        const root = $(element);
        const link = root.find('.txt-box h3 a').first();
        const publisher = stripHtml(root.find('.s-p .all-time-y2').first().text());
        if (source.publisher && publisher !== source.publisher) return;
        const href = link.attr('href');
        if (!href) return;
        const timestampMatch = root.html()?.match(/timeConvert\('(\d+)'\)/);
        candidates.push({
          source: source.name,
          sourceType: 'watchlist-wechat',
          title: stripHtml(link.html() || link.text()),
          url: new URL(href, 'https://weixin.sogou.com').toString(),
          publishedAt: timestampMatch ? new Date(Number(timestampMatch[1]) * 1000).toISOString() : '',
          summary: compactText(root.find('.txt-info').html() || '', 800),
          publisher,
        });
      });
      items.push(...candidates.slice(0, config.maxItemsPerSource || 3));
      if (candidates.length === 0) {
        notes.push(`${source.name}: 未在公开搜狗微信结果中找到发布方为“${source.publisher || source.query}”的近期条目。`);
      }
    } catch (error) {
      errors.push(`${source.name}: ${error.message}`);
    }
  }
  return items;
}

async function collectAiWatchlist() {
  const errors = [];
  const notes = [];
  const config = await loadWatchlistConfig(errors);
  if (!config.enabled) return { items: [], notes, errors };
  const [podcasts, latePost, wechat] = await Promise.all([
    collectWatchlistPodcasts(config, errors),
    collectLatePost(config, errors),
    collectWechatSearches(config, errors, notes),
  ]);
  const items = [...podcasts, ...latePost, ...wechat]
    .filter((item) => item.title && item.url)
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  return { items, notes, errors };
}

function buildPrompt(date, feeds, watchlist) {
  return `Create a concise Chinese AI industry digest for ${date} from the JSON below.

Return Notion-flavored Markdown only. Start with "# AI Builders Digest - ${date}".
Use sections in this order when content exists: "## X / Twitter", "## Official Blogs", "## 重点关注源更新", "## Podcasts".

Rules:
- Write natural Simplified Chinese, while retaining common technical terms such as AI, LLM, API, agent, prompt and model names in English.
- Include only substantive opinions, technical discussions, product announcements, research findings or practical lessons.
- Skip jokes, personal chatter, engagement bait and promotional filler.
- Never invent information, roles, quotations or links.
- Every included item must contain its original URL from the JSON. Omit items without a specific original URL.
- Do not use a podcast channel homepage as an episode URL.
- Summarize each selected X author in 2-4 sentences.
- Summarize each selected blog post in 100-250 Chinese characters.
- In "重点关注源更新", group by source and summarize the latest updates from the watchlist sources: 海外独角兽（微信公众号）, Dwarkesh Podcast, 张小珺Jùn｜商业访谈录, 晚点 LatePost/晚点聊/晚点在场, and Sharp Tech with Ben Thompson. Every bullet must include its original URL. If a source only has a public-search note and no item, mention the limitation briefly; do not invent updates.
- In the original "Podcasts" section, summarize at most one central Follow Builders podcast in 300-600 Chinese characters.
- End with: Generated through the Follow Builders skill: https://github.com/zarazhangrui/follow-builders

SOURCE JSON:
${JSON.stringify(feeds)}

WATCHLIST JSON:
${JSON.stringify(watchlist)}`;
}

async function findExistingPage(notion, dataSourceId, titleProperty, title) {
  const result = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: {
      property: titleProperty,
      title: { equals: title },
    },
    page_size: 1,
  });
  return result.results[0];
}

async function resolveNotionTarget(title) {
  const notion = new Client({
    auth: process.env.NOTION_TOKEN,
    notionVersion: '2026-03-11',
  });
  const database = await notion.databases.retrieve({
    database_id: process.env.NOTION_DATABASE_ID,
  });
  const dataSource = selectDataSource(database);
  const schema = await notion.dataSources.retrieve({
    data_source_id: dataSource.id,
  });
  const titleProperty = findTitleProperty(schema.properties);
  const existing = await findExistingPage(notion, dataSource.id, titleProperty, title);
  return { notion, dataSource, titleProperty, existing };
}

async function main() {
  const dryRun = process.env.AI_DRY_RUN === 'true';
  if (!dryRun) {
    requireEnv(process.env, ['DEEPSEEK_API_KEY', 'NOTION_TOKEN', 'NOTION_DATABASE_ID']);
  }

  const date = beijingDate();
  const title = makePageTitle(date);
  let target;
  if (!dryRun) {
    target = await resolveNotionTarget(title);
    if (target.existing && process.env.FORCE_NOTION_CREATE !== 'true') {
      console.log(`Notion page already exists; skipped model call: ${target.existing.url}`);
      return;
    }
  }

  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchJson(FEED_X_URL),
    fetchJson(FEED_PODCASTS_URL),
    fetchJson(FEED_BLOGS_URL),
  ]);
  const feeds = compactFeeds({ feedX, feedPodcasts, feedBlogs });
  const watchlist = await collectAiWatchlist();
  console.log(`Collected AI watchlist items: ${watchlist.items.length}; notes: ${watchlist.notes.length}; errors: ${watchlist.errors.length}`);

  if (dryRun) {
    console.log(JSON.stringify({
      feedStats: {
        x: feeds.x.length,
        podcasts: feeds.podcasts.length,
        blogs: feeds.blogs.length,
      },
      watchlist,
    }, null, 2));
    return;
  }

  const deepseek = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com',
  });
  const response = await deepseek.chat.completions.create({
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    messages: [
      {
        role: 'system',
        content: 'You are a careful editor. Follow the source-only and URL rules exactly.',
      },
      { role: 'user', content: buildPrompt(date, feeds, watchlist) },
    ],
    stream: false,
    extra_body: { thinking: { type: 'disabled' } },
  });
  const markdown = response.choices[0]?.message?.content?.trim();
  if (!markdown) {
    throw new Error('DeepSeek returned an empty digest.');
  }
  if (response.usage) {
    console.log(`DeepSeek usage: ${JSON.stringify(response.usage)}`);
  }

  const page = await target.notion.pages.create({
    parent: { data_source_id: target.dataSource.id },
    properties: {
      [target.titleProperty]: {
        title: [{ text: { content: title } }],
      },
    },
    icon: { type: 'emoji', emoji: '🧠' },
    markdown,
  });
  console.log(`Created Notion page: ${page.url}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
