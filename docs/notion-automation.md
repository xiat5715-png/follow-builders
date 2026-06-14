# Notion Automation

This repository can publish a Chinese AI Builders Digest to Notion every day at
08:00 Asia/Shanghai.

## Notion setup

1. Create an internal integration at https://www.notion.so/profile/integrations.
2. Give it permission to read content and insert content.
3. Create a Notion database for the digests. It only needs one title property;
   the property can have any name.
4. Open the database menu, choose `Connections`, and connect the integration.
5. Copy the database ID from its URL.

## GitHub configuration

Add these repository secrets under `Settings > Secrets and variables > Actions`:

- `NOTION_TOKEN`: the Notion internal integration token.
- `NOTION_DATABASE_ID`: the database ID from the Notion URL.
- `OPENAI_API_KEY`: an OpenAI API key used to generate the Chinese digest.

Optional repository variable:

- `OPENAI_MODEL`: overrides the default `gpt-5.5` model.

The `Publish Digest to Notion` workflow runs every day at 00:00 UTC, which is
08:00 in Asia/Shanghai. It can also be started manually from the Actions tab.

The publisher reads the centrally maintained Follow Builders feeds, so the fork
does not need X or podcast API credentials. If a page with the same daily title
already exists, the workflow skips creation to avoid duplicates.
