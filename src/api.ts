/**
 * Thin HTTP layer over the GenRelay generation API.
 *
 * Deliberately dependency-free (global fetch, Node 18+): an MCP server gets
 * launched by editors and desktop apps on someone else's machine, so every
 * extra dependency is another way for `npx genrelay-mcp` to fail on a laptop
 * we will never see.
 */

export const DEFAULT_BASE_URL = "https://genrelay.ai/v1";

export type JobStatus = "queued" | "in_progress" | "completed" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
  model?: string;
  progress?: number;
  output_url?: string;
  created_at?: number;
  completed_at?: number;
  error?: { message?: string; code?: string };
  [key: string]: unknown;
}

export interface CreateParams {
  model: string;
  prompt: string;
  seconds?: number;
  size?: string;
  tier?: string;
  reference_images?: string[];
  metadata?: Record<string, unknown>;
}

/** An API error carrying the HTTP status, so callers can phrase advice. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class GenRelayApi {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {
    this.baseUrl = this.baseUrl.replace(/\/+$/, "");
  }

  async create(params: CreateParams): Promise<Job> {
    return this.request<Job>("POST", "/videos", params);
  }

  async retrieve(taskId: string): Promise<Job> {
    return this.request<Job>("GET", `/videos/${encodeURIComponent(taskId)}`);
  }

  /** Public download URL for a finished job. */
  contentUrl(taskId: string): string {
    return `${this.baseUrl}/videos/${encodeURIComponent(taskId)}/content`;
  }

  /** Fetch the finished asset as base64 — used to inline images in chat. */
  async fetchContent(taskId: string): Promise<{ base64: string; mimeType: string }> {
    const res = await fetch(this.contentUrl(taskId), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      throw new ApiError(`download failed with HTTP ${res.status}`, res.status);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      base64: buf.toString("base64"),
      mimeType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /**
   * Poll until the job settles or `budgetMs` runs out.
   *
   * The budget exists because MCP tool calls run inside a client-side timeout
   * (often 60s), while a 1080p clip takes minutes. Running out is a normal
   * outcome, not an error: we return the unfinished job so the tool can hand
   * the caller a task id to check later.
   */
  async poll(taskId: string, budgetMs: number, intervalMs = 3000): Promise<Job> {
    const deadline = Date.now() + budgetMs;
    let job = await this.retrieve(taskId);

    while (job.status !== "completed" && job.status !== "failed") {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return job;
      await sleep(Math.min(intervalMs, remaining));
      job = await this.retrieve(taskId);
    }
    return job;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ApiError(`cannot reach ${this.baseUrl}: ${String(err)}`, 0);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const { message, code } = extractError(parsed);
      throw new ApiError(message || `HTTP ${res.status}`, res.status, code);
    }
    return parsed as T;
  }
}

function extractError(body: unknown): { message: string; code?: string } {
  if (typeof body === "string") return { message: body.slice(0, 300) };
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const err = obj.error;
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      return { message: String(e.message ?? ""), code: e.code ? String(e.code) : undefined };
    }
    if (typeof err === "string") return { message: err };
    if (obj.message) return { message: String(obj.message) };
  }
  return { message: "" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
