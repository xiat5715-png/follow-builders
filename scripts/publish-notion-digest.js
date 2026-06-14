#!/usr/bin/env node

import 'dotenv/config';
import OpenAI from 'openai';
import { Client } from '@notionhq/client';
import {
  compactFeeds,
  findTitleProperty,
  makePageTitle,
  requireEnv,
  selectDataSource,
} from './notion-utils.js';

const FEED_X_URL = process.env.FEED_X_URL ||
  'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL = process.env.FEED_PODCASTS_URL ||
  'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL = process.env.FEED_BLOGS_URL ||
  'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

function beijingDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function buildPrompt(date, feeds) {
  return `Create a concise Chinese AI industry digest for ${date} from the JSON below.

Return Notion-flavored Markdown only. Start with "# AI Builders Digest - ${date}".
Use sections in this order when content exists: "## X / Twitter", "## Official Blogs", "## Podcasts".

Rules:
- Write natural Simplified Chinese, while retaining common technical terms such as AI, LLM, API, agent, prompt and model names in English.
- Include only substantive opinions, technical discussions, product announcements, research findings or practical lessons.
- Skip jokes, personal chatter, engagement bait and promotional filler.
- Never invent information, roles, quotations or links.
- Every included item must contain its original URL from the JSON. Omit items without a specific original URL.
- Do not use a podcast channel homepage as an episode URL.
- Summarize each selected X author in 2-4 sentences.
- Summarize each selected blog post in 100-250 Chinese characters.
- Summarize at most one podcast in 300-600 Chinese characters.
- End with: Generated through the Follow Builders skill: https://github.com/zarazhangrui/follow-builders

SOURCE JSON:
${JSON.stringify(feeds)}`;
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

async function main() {
  requireEnv(process.env, ['DEEPSEEK_API_KEY', 'NOTION_TOKEN', 'NOTION_DATABASE_ID']);

  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchJson(FEED_X_URL),
    fetchJson(FEED_PODCASTS_URL),
    fetchJson(FEED_BLOGS_URL),
  ]);
  const date = beijingDate();
  const title = makePageTitle(date);
  const feeds = compactFeeds({ feedX, feedPodcasts, feedBlogs });

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
      { role: 'user', content: buildPrompt(date, feeds) },
    ],
    stream: false,
    extra_body: { thinking: { type: 'disabled' } },
  });
  const markdown = response.choices[0]?.message?.content?.trim();
  if (!markdown) {
    throw new Error('DeepSeek returned an empty digest.');
  }

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
  if (existing && process.env.FORCE_NOTION_CREATE !== 'true') {
    console.log(`Notion page already exists: ${existing.url}`);
    return;
  }

  const page = await notion.pages.create({
    parent: { data_source_id: dataSource.id },
    properties: {
      [titleProperty]: {
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
