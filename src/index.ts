#!/usr/bin/env node
/**
 * GenRelay MCP server — video and image generation as tools for Claude
 * Desktop, Cursor, and anything else that speaks MCP.
 *
 * The central design constraint: **MCP tool calls run under a client-side
 * timeout, usually around 60 seconds, while video generation takes minutes.**
 * So the tools split along that line rather than along "video vs image":
 *
 *   - images usually finish inside the budget, so `generate_image` waits and
 *     returns the picture inline;
 *   - video usually does not, so `generate_video` submits, waits only as long
 *     as it safely can, and hands back a task id;
 *   - `check_job` picks that task id back up.
 *
 * Handing back a task id is a real answer, not a failure — the job keeps
 * running server-side, and resubmitting would bill a second time.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ApiError, DEFAULT_BASE_URL, GenRelayApi, type Job } from "./api.js";

const VERSION = "0.1.2";

/** Stay under the ~60s client timeout with room for the round trips. */
const IMAGE_WAIT_MS = 50_000;
const VIDEO_WAIT_MS = 45_000;

const VIDEO_MODELS = [
  "veo_3_1",
  "veo_3_1-fl",
  "veo_3_1-components",
  "grok-imagine-video-1-5-preview",
  "grok-imagine-1-0-video",
  "omni-flash",
  "omni_flash_abra_edit",
] as const;

const IMAGE_MODELS = ["nano-banana-pro", "nano-banana-2", "gpt-image-2"] as const;

const apiKey = process.env.GENRELAY_API_KEY ?? "";
const api = new GenRelayApi(apiKey, process.env.GENRELAY_BASE_URL ?? DEFAULT_BASE_URL);

const server = new McpServer({ name: "genrelay", version: VERSION });

// --------------------------------------------------------------- helpers

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function fail(body: string) {
  return { ...text(body), isError: true };
}

/** Turn any thrown value into advice the model can act on. */
function explain(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
      case 403:
        return "GenRelay rejected the API key. Check GENRELAY_API_KEY in the MCP server config.";
      case 402:
        return "The GenRelay account is out of credits. Top up at https://genrelay.ai to continue.";
      case 429:
        return "Rate limited by GenRelay. Wait a few seconds and try again.";
      case 0:
        return err.message;
      default:
        return `GenRelay error (HTTP ${err.status})${err.code ? ` [${err.code}]` : ""}: ${err.message}`;
    }
  }
  return `Unexpected error: ${String(err)}`;
}

function describe(job: Job): string {
  const bits = [`task id: ${job.id}`, `status: ${job.status}`];
  if (job.model) bits.push(`model: ${job.model}`);
  if (typeof job.progress === "number" && job.status !== "completed") {
    bits.push(`progress: ${job.progress}%`);
  }
  return bits.join("\n");
}

function requireKey(): string | null {
  return apiKey
    ? null
    : "GENRELAY_API_KEY is not set. Add it to the MCP server config, then restart the client.";
}

// ----------------------------------------------------------------- tools

server.registerTool(
  "generate_video",
  {
    title: "Generate a video",
    description:
      "Generate a video with Veo 3.1, Grok Imagine or Omni Flash. Generation usually takes " +
      "1-5 minutes, longer than a tool call can wait — if it is still running when the wait " +
      "budget runs out, this returns a task id to check later with check_job. " +
      "Supports text-to-video and image-to-video (pass reference_images).",
    inputSchema: {
      prompt: z.string().describe("What the video should show."),
      model: z
        .enum(VIDEO_MODELS)
        .default("veo_3_1")
        .describe("Which video model to use."),
      seconds: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe("Clip length in seconds (default 4)."),
      size: z
        .string()
        .optional()
        .describe('Pixel size as "WxH", e.g. "1280x720". Aspect ratio is inferred from it.'),
      tier: z
        .enum(["720p", "1080p", "4k"])
        .optional()
        .describe(
          "Resolution tier. Worth setting: pricing is per tier, and a size matching no " +
            "tier falls back to the model's base rate.",
        ),
      reference_images: z
        .array(z.string())
        .optional()
        .describe("HTTPS or data: URLs to guide generation (image-to-video)."),
    },
  },
  async (args) => {
    const missing = requireKey();
    if (missing) return fail(missing);

    try {
      const job = await api.create({
        model: args.model,
        prompt: args.prompt,
        seconds: args.seconds,
        size: args.size,
        tier: args.tier,
        reference_images: args.reference_images,
      });

      const settled = await api.poll(job.id, VIDEO_WAIT_MS);

      if (settled.status === "completed") {
        return text(
          `Video ready.\n\n${describe(settled)}\ndownload: ${settled.output_url ?? api.contentUrl(settled.id)}`,
        );
      }
      if (settled.status === "failed") {
        return fail(
          `Generation failed.\n\n${describe(settled)}\nreason: ${settled.error?.message ?? "no detail given"}`,
        );
      }
      return text(
        `Still generating — this is normal for video.\n\n${describe(settled)}\n\n` +
          `Call check_job with task id "${settled.id}" in a minute or two. ` +
          `The job keeps running; do not resubmit, that would bill again.`,
      );
    } catch (err) {
      return fail(explain(err));
    }
  },
);

server.registerTool(
  "generate_image",
  {
    title: "Generate an image",
    description:
      "Generate an image with Nano Banana Pro/2 or GPT Image 2. Usually finishes within the " +
      "tool-call budget and returns the picture inline. Supports image editing and " +
      "reference-guided generation via reference_images.",
    inputSchema: {
      prompt: z.string().describe("What the image should show."),
      model: z
        .enum(IMAGE_MODELS)
        .default("nano-banana-pro")
        .describe("Which image model to use."),
      size: z.string().optional().describe('Pixel size as "WxH", e.g. "1024x1024".'),
      tier: z
        .enum(["1k", "2k", "4k"])
        .optional()
        .describe("Resolution tier. Pricing is per tier — set it explicitly."),
      reference_images: z
        .array(z.string())
        .optional()
        .describe("HTTPS or data: URLs to edit or take guidance from."),
    },
  },
  async (args) => {
    const missing = requireKey();
    if (missing) return fail(missing);

    try {
      const job = await api.create({
        model: args.model,
        prompt: args.prompt,
        size: args.size,
        tier: args.tier,
        reference_images: args.reference_images,
      });

      const settled = await api.poll(job.id, IMAGE_WAIT_MS, 2000);

      if (settled.status === "failed") {
        return fail(
          `Generation failed.\n\n${describe(settled)}\nreason: ${settled.error?.message ?? "no detail given"}`,
        );
      }
      if (settled.status !== "completed") {
        return text(
          `Still generating.\n\n${describe(settled)}\n\n` +
            `Call check_job with task id "${settled.id}" shortly.`,
        );
      }

      // Inline the picture so it shows in the conversation instead of being a
      // link the user has to open. Falling back to the URL matters: the image
      // may be large, or the transport may not accept binary content.
      try {
        const { base64, mimeType } = await api.fetchContent(settled.id);
        return {
          content: [
            { type: "text" as const, text: `Image ready.\n\n${describe(settled)}` },
            { type: "image" as const, data: base64, mimeType },
          ],
        };
      } catch {
        return text(
          `Image ready.\n\n${describe(settled)}\ndownload: ${settled.output_url ?? api.contentUrl(settled.id)}`,
        );
      }
    } catch (err) {
      return fail(explain(err));
    }
  },
);

server.registerTool(
  "check_job",
  {
    title: "Check a generation job",
    description:
      "Check a job started earlier by generate_video or generate_image, using its task id. " +
      "Returns the current status and, once finished, the download URL.",
    inputSchema: {
      task_id: z.string().describe('The task id, e.g. "task_abc123".'),
    },
  },
  async ({ task_id }) => {
    const missing = requireKey();
    if (missing) return fail(missing);

    try {
      const job = await api.retrieve(task_id);
      if (job.status === "completed") {
        return text(
          `Done.\n\n${describe(job)}\ndownload: ${job.output_url ?? api.contentUrl(job.id)}`,
        );
      }
      if (job.status === "failed") {
        return fail(
          `Failed.\n\n${describe(job)}\nreason: ${job.error?.message ?? "no detail given"}`,
        );
      }
      return text(`${describe(job)}\n\nStill running — check again shortly.`);
    } catch (err) {
      return fail(explain(err));
    }
  },
);

server.registerTool(
  "list_models",
  {
    title: "List available models",
    description:
      "List the video and image models this server can generate with, and what each is for.",
    inputSchema: {},
  },
  async () => {
    const lines = [
      "Video models:",
      "  veo_3_1                         Google Veo 3.1 — highest quality, with audio",
      "  veo_3_1-fl                      Veo 3.1 first/last frame — supply both endpoints",
      "  veo_3_1-components              Veo 3.1 with component references",
      "  grok-imagine-video-1-5-preview  xAI Grok Imagine 1.5",
      "  grok-imagine-1-0-video          xAI Grok Imagine 1.0",
      "  omni-flash                      Fast, good for longer clips",
      "  omni_flash_abra_edit            Video editing from a source video",
      "",
      "Image models:",
      "  nano-banana-pro                 Google, highest quality",
      "  nano-banana-2                   Google, faster and cheaper",
      "  gpt-image-2                     OpenAI GPT Image 2",
      "",
      "Tiers: images 1k/2k/4k, Veo video 720p/1080p/4k. Pricing is per tier.",
      "Current list and per-model options: https://genrelay.ai/models",
    ];
    return text(lines.join("\n"));
  },
);

// ------------------------------------------------------------------ boot

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the protocol — anything human-readable must go to stderr.
  console.error(`genrelay-mcp ${VERSION} ready${apiKey ? "" : " (no GENRELAY_API_KEY set)"}`);
}

main().catch((err) => {
  console.error("genrelay-mcp failed to start:", err);
  process.exit(1);
});
