export function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

export function findTitleProperty(properties) {
  const entry = Object.entries(properties || {}).find(([, value]) => value.type === 'title');
  if (!entry) {
    throw new Error('The Notion data source does not have a title property.');
  }
  return entry[0];
}

export function selectDataSource(database) {
  const sources = database?.data_sources || [];
  if (sources.length === 0) {
    throw new Error('The Notion database does not contain a data source.');
  }
  return sources[0];
}

export function makePageTitle(date) {
  return `AI Builders Digest - ${date}`;
}

export function compactFeeds({ feedX, feedPodcasts, feedBlogs }) {
  return {
    generatedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt,
    x: (feedX?.x || []).map(({ name, bio, tweets }) => ({
      name,
      bio,
      tweets: (tweets || []).map(({ text, url }) => ({ text, url })),
    })),
    podcasts: (feedPodcasts?.podcasts || []).map(({ name, title, url, publishedAt, transcript }) => ({
      name,
      title,
      url,
      publishedAt,
      transcript,
    })),
    blogs: (feedBlogs?.blogs || []).map(({ name, title, author, url, content, text, publishedAt }) => ({
      name,
      title,
      author,
      url,
      publishedAt,
      content: content || text,
    })),
  };
}
