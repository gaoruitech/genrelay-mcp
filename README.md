# genrelay-mcp

MCP server for [GenRelay](https://genrelay.ai) — generate **video and images** from Claude Desktop, Cursor, or any MCP client.

One server, several models: **Veo 3.1**, **Grok Imagine**, **Omni Flash**, **Nano Banana Pro/2**, **GPT Image 2**.

## Install

Nothing to install — point your MCP client at it with `npx`.

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "genrelay": {
      "command": "npx",
      "args": ["-y", "genrelay-mcp"],
      "env": { "GENRELAY_API_KEY": "sk-..." }
    }
  }
}
```

**Cursor** — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "genrelay": {
      "command": "npx",
      "args": ["-y", "genrelay-mcp"],
      "env": { "GENRELAY_API_KEY": "sk-..." }
    }
  }
}
```

Get a key at [genrelay.ai](https://genrelay.ai). Restart the client after editing the config.

## Tools

| Tool | What it does |
|---|---|
| `generate_video` | Text-to-video and image-to-video. Returns the clip, or a task id if it's still running |
| `generate_image` | Image generation and editing. Returns the picture **inline** |
| `check_job` | Pick up a job by task id |
| `list_models` | What's available and what each model is for |

Then just ask:

> Generate an 8-second video of a neon fox running through a rainy city at night, 1080p

## About the wait

Video generation takes **1–5 minutes** — longer than an MCP tool call is allowed to run. So `generate_video` waits as long as it safely can, then hands back a task id:

```
Still generating — this is normal for video.

task id: task_abc123
status: in_progress
progress: 35%

Call check_job with task id "task_abc123" in a minute or two.
```

That's a normal outcome, not a failure. The job keeps running server-side — **use `check_job`, don't resubmit** (resubmitting bills a second time).

Images usually finish inside the budget and come back inline.

## Models

**Video**

| Model | Notes |
|---|---|
| `veo_3_1` | Google Veo 3.1 — highest quality, with audio |
| `veo_3_1-fl` | first/last frame — supply both endpoints |
| `veo_3_1-components` | component-guided |
| `grok-imagine-video-1-5-preview` | xAI Grok Imagine 1.5 |
| `grok-imagine-1-0-video` | xAI Grok Imagine 1.0 |
| `omni-flash` | fast, good for longer clips |
| `omni_flash_abra_edit` | video editing from a source video |

**Image** — `nano-banana-pro`, `nano-banana-2`, `gpt-image-2`

Tiers: images `1k`/`2k`/`4k`, Veo video `720p`/`1080p`/`4k`. **Pricing is per tier**, and a `size` matching no tier falls back to the model's base rate — so set `tier` explicitly when cost matters.

## Configuration

| Variable | |
|---|---|
| `GENRELAY_API_KEY` | required |
| `GENRELAY_BASE_URL` | optional, defaults to `https://genrelay.ai/v1` |

## Also available

- **Python SDK** — [`pip install genrelay`](https://pypi.org/project/genrelay/)
- **Chat & image edits** are OpenAI-compatible: point the official `openai` package at `https://genrelay.ai/v1`

## Development

```bash
npm install
npm run build
node test/smoke.mjs   # boots the server and speaks MCP to it
```

## License

MIT
