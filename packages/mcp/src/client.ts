/**
 * Typed HTTP client for the Kinglet API.
 *
 * The MCP server never opens the database and never re-implements auth: every
 * tool goes through the public `/v1` API with a `km_` bearer token. Error
 * messages are deliberately short and never include the key or a raw response
 * body that might contain one.
 *
 * Response decoding lives here at the I/O boundary. Zod schemas describe only
 * the fields we expose; anything else in a server response (channel URLs,
 * internal errors, future fields) is discarded by object parsing.
 */

import { z } from "zod";
import type { McpConfig } from "./config.ts";

export const DEFAULT_ROWS = 50;
export const MAX_ROWS = 200;
export const MAX_MESSAGE_BYTES = 4 * 1024;
export const MAX_FIELDS_BYTES = 8 * 1024;

const LEVEL_NAMES = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
const ERROR_TEXT_LIMIT = 512;

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
}

export interface KeyCapabilities {
  "logs.read": boolean;
  "logs.write": boolean;
  "monitors.read": boolean;
  "monitors.write": boolean;
}

export interface KeyContext {
  project: ProjectSummary;
  key: {
    id: string;
    name: string;
    keyType: string;
    scopes: string[];
  };
  capabilities: KeyCapabilities;
  server: {
    version: string;
    retentionDays: number;
  };
}

export interface ClientEvent {
  id: number | null;
  uid: string | null;
  ts: number;
  level: number;
  levelName: string | null;
  service: string | null;
  env: string | null;
  message: string;
  fields: JsonObject | null;
  /** True when the message or fields were shortened for this response. */
  truncated?: boolean;
  fieldsTruncated?: true;
}

export interface SearchEventsResult {
  events: ClientEvent[];
  nextCursor: number | null;
  truncated?: boolean;
}

export interface SearchEventsParams {
  q?: string;
  from?: number;
  to?: number;
  limit?: number;
  cursor?: number;
}

export interface EventContextResult {
  event: ClientEvent;
  before: ClientEvent[];
  after: ClientEvent[];
}

export interface HistogramPoint {
  ts: number;
  counts: number[];
}

export interface HistogramResult {
  from: number;
  to: number;
  bucketMs: number;
  points: HistogramPoint[];
}

export type AggregateGroupBy = "service" | "level" | "env";

export interface AggregateGroup {
  /** Null is a real group: events without a service or env. */
  key: string | null;
  count: number;
}

export interface AggregateEventsParams {
  q?: string;
  from?: number;
  to?: number;
  groupBy?: AggregateGroupBy;
  limit?: number;
}

export interface AggregateEventsResult {
  from: number;
  to: number;
  total: number;
  groupBy?: AggregateGroupBy;
  groups?: AggregateGroup[];
  truncated?: true;
}

export interface ServiceInfo {
  name: string;
  count: number;
  lastSeenAt?: number;
}

export interface ChannelHealth {
  status: string;
  lastDeliveryAt: number | null;
}

export interface ChannelSummary {
  id?: string;
  name?: string;
  type: string;
  enabled?: boolean;
  health?: string | ChannelHealth;
}

export type MonitorKind = "match" | "count_above" | "count_below";

export interface MonitorInfo {
  id: string;
  projectId: string | null;
  name: string;
  query: string;
  kind: string;
  threshold: number;
  windowMs: number;
  intervalMs: number;
  cooldownMs: number;
  enabled: boolean;
  channelIds: string[];
  channels: ChannelSummary[];
  createdAt: number | null;
  updatedAt: number | null;
  lastEvalAt: number | null;
}

export interface AlertInfo {
  id: string;
  monitorId: string;
  monitorName: string | null;
  state: string;
  summary: string;
  count: number | null;
  sampleMessage: string | null;
  firedAt: number;
  resolvedAt: number | null;
  notifyStatus: string | null;
}

export type AlertState = "fired" | "resolved";

export interface ListAlertsParams {
  limit?: number;
  monitorId?: string;
  state?: AlertState;
  from?: number;
  to?: number;
}

export interface MonitorInput {
  name?: string;
  query?: string;
  kind?: MonitorKind;
  threshold?: number;
  windowMs?: number;
  intervalMs?: number;
  cooldownMs?: number;
  enabled?: boolean;
  /** Channel ids only. URLs are a notification-channel admin concern. */
  channelIds?: string[];
}

export class KingletApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "KingletApiError";
    this.status = status;
  }
}

function protocolError(): KingletApiError {
  return new KingletApiError("unexpected response shape from the Kinglet server");
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
}

function truncateBytes(text: string, maxBytes: number): TruncatedText {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };

  const budget = Math.max(0, maxBytes - Buffer.byteLength("…", "utf8"));
  let out = "";
  let used = 0;

  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");

    if (used + size > budget) break;
    out += char;
    used += size;
  }

  return { text: `${out}…`, truncated: true };
}

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const JsonObjectSchema: z.ZodType<JsonObject> = z.lazy(() => z.record(z.string(), JsonValueSchema));

const ErrorBodySchema = z.object({ error: z.string() });

function safeErrorText(payload: JsonValue): string | null {
  const parsed = ErrorBodySchema.safeParse(payload);

  if (!parsed.success) return null;

  return truncateBytes(parsed.data.error.replace(/[\r\n]+/g, " "), ERROR_TEXT_LIMIT).text;
}

function httpError(status: number, payload: JsonValue): KingletApiError {
  switch (status) {
    case 400:
    case 409:
    case 413:
    case 422:
    case 507:
      return new KingletApiError(
        safeErrorText(payload) ?? `Kinglet rejected the request (HTTP ${status})`,
        status,
      );
    case 401:
      return new KingletApiError(
        "Kinglet rejected the MCP key: it is invalid, revoked, or its owner is disabled",
        401,
      );
    case 403:
      return new KingletApiError(
        safeErrorText(payload) ??
          "the MCP key is missing the scope required for this tool (or the route does not accept MCP keys)",
        403,
      );
    case 404:
      return new KingletApiError(
        "not found (the server may be older than this MCP package, or the item was deleted)",
        404,
      );
    case 429:
      return new KingletApiError("Kinglet rate limit exceeded (60 requests/minute per key)", 429);
    default:
      return new KingletApiError(
        status >= 500
          ? `Kinglet server error (HTTP ${status})`
          : (safeErrorText(payload) ?? `Kinglet request failed (HTTP ${status})`),
        status,
      );
  }
}

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

const KeyCapabilitiesSchema = z.object({
  "logs.read": z.boolean(),
  "logs.write": z.boolean(),
  "monitors.read": z.boolean(),
  "monitors.write": z.boolean(),
});

const ContextSchema = z.object({
  project: ProjectSchema,
  key: z.object({
    id: z.string(),
    name: z.string(),
    keyType: z.string(),
    scopes: z.array(z.string()),
  }),
  capabilities: KeyCapabilitiesSchema,
  server: z.object({
    version: z.string(),
    retentionDays: z.number(),
  }),
});

const EventSchema = z.object({
  id: z.number().nullable().default(null),
  uid: z.string().nullable().default(null),
  ts: z.number(),
  level: z.number(),
  service: z.string().nullable().default(null),
  env: z.string().nullable().default(null),
  message: z.string(),
  fields: JsonObjectSchema.nullable().default(null),
});

type ParsedEvent = z.infer<typeof EventSchema>;

function toClientEvent(event: ParsedEvent): ClientEvent {
  const message = truncateBytes(event.message, MAX_MESSAGE_BYTES);
  let fields = event.fields;
  let fieldsTruncated = false;

  if (fields) {
    const encoded = JSON.stringify(fields);

    if (Buffer.byteLength(encoded, "utf8") > MAX_FIELDS_BYTES) {
      fields = null;
      fieldsTruncated = true;
    }
  }

  const levelIndex = Math.trunc(event.level);

  const result: ClientEvent = {
    id: event.id,
    uid: event.uid,
    ts: event.ts,
    level: event.level,
    levelName:
      levelIndex >= 0 && levelIndex < LEVEL_NAMES.length ? (LEVEL_NAMES[levelIndex] ?? null) : null,
    service: event.service,
    env: event.env,
    message: message.text,
    fields,
  };

  if (message.truncated || fieldsTruncated) result.truncated = true;

  if (fieldsTruncated) result.fieldsTruncated = true;

  return result;
}

const ChannelHealthSchema = z
  .union([
    z.string(),
    z.object({
      status: z.string(),
      lastDeliveryAt: z.number().nullable().default(null),
    }),
  ])
  .optional()
  .catch(undefined);

const ChannelSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  type: z.string(),
  enabled: z.boolean().optional(),
  health: ChannelHealthSchema,
});

type ParsedChannel = z.infer<typeof ChannelSchema>;

function toChannelSummary(channel: ParsedChannel): ChannelSummary {
  const summary: ChannelSummary = { type: channel.type };

  if (channel.id !== undefined) summary.id = channel.id;

  if (channel.name !== undefined) summary.name = channel.name;

  if (channel.enabled !== undefined) summary.enabled = channel.enabled;

  if (channel.health !== undefined) summary.health = channel.health;

  return summary;
}

const MonitorSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable().default(null),
  name: z.string().default(""),
  query: z.string().default(""),
  kind: z.string().default("count_above"),
  threshold: z.number().default(0),
  windowMs: z.number().default(0),
  intervalMs: z.number().default(0),
  cooldownMs: z.number().default(0),
  enabled: z.boolean().default(false),
  channelIds: z.array(z.string()).default([]),
  resolvedChannels: z.array(z.unknown()).default([]),
  channels: z.array(z.unknown()).default([]),
  createdAt: z.number().nullable().default(null),
  updatedAt: z.number().nullable().default(null),
  lastEvalAt: z.number().nullable().default(null),
});

type ParsedMonitor = z.infer<typeof MonitorSchema>;

function toMonitorInfo(monitor: ParsedMonitor): MonitorInfo {
  const rawChannels =
    monitor.resolvedChannels.length > 0 ? monitor.resolvedChannels : monitor.channels;

  return {
    id: monitor.id,
    projectId: monitor.projectId,
    name: monitor.name,
    query: monitor.query,
    kind: monitor.kind,
    threshold: monitor.threshold,
    windowMs: monitor.windowMs,
    intervalMs: monitor.intervalMs,
    cooldownMs: monitor.cooldownMs,
    enabled: monitor.enabled,
    channelIds: monitor.channelIds,
    channels: rawChannels.flatMap((channel): ChannelSummary[] => {
      const parsed = ChannelSchema.safeParse(channel);

      return parsed.success ? [toChannelSummary(parsed.data)] : [];
    }),
    createdAt: monitor.createdAt,
    updatedAt: monitor.updatedAt,
    lastEvalAt: monitor.lastEvalAt,
  };
}

const AlertSchema = z.object({
  id: z.string(),
  monitorId: z.string().default(""),
  monitorName: z.string().nullable().default(null),
  state: z.string().default("fired"),
  summary: z.string().default(""),
  count: z.number().nullable().default(null),
  sampleMessage: z.string().nullable().default(null),
  firedAt: z.number().default(0),
  resolvedAt: z.number().nullable().default(null),
  notifyStatus: z.string().nullable().default(null),
});

type ParsedAlert = z.infer<typeof AlertSchema>;

function toAlertInfo(alert: ParsedAlert): AlertInfo {
  return {
    id: alert.id,
    monitorId: alert.monitorId,
    monitorName: alert.monitorName,
    state: alert.state,
    summary: truncateBytes(alert.summary, MAX_MESSAGE_BYTES).text,
    count: alert.count,
    sampleMessage:
      alert.sampleMessage === null
        ? null
        : truncateBytes(alert.sampleMessage, MAX_MESSAGE_BYTES).text,
    firedAt: alert.firedAt,
    resolvedAt: alert.resolvedAt,
    notifyStatus: alert.notifyStatus,
  };
}

const ServiceSchema = z.object({
  name: z.string(),
  count: z.number().default(0),
  lastSeenAt: z.number().optional(),
});

const HistogramPointSchema = z.object({
  ts: z.number(),
  counts: z.array(z.number()).default([]),
});

const EventsResponseSchema = z.object({
  events: z.array(z.unknown()),
  nextCursor: z.number().nullable().default(null),
});

const EventResponseSchema = z.object({ event: z.unknown() });

const EventContextResponseSchema = z.object({
  event: z.unknown(),
  before: z.array(z.unknown()),
  after: z.array(z.unknown()),
});

const HistogramResponseSchema = z.object({
  from: z.number(),
  to: z.number(),
  bucketMs: z.number(),
  points: z.array(z.unknown()),
});

const AggregateGroupSchema = z.object({
  key: z.string().nullable(),
  count: z.number(),
});

const AggregateResponseSchema = z.object({
  from: z.number(),
  to: z.number(),
  total: z.number(),
  groupBy: z.enum(["service", "level", "env"]).optional(),
  groups: z.array(z.unknown()).optional(),
  truncated: z.boolean().optional(),
});

const ServicesResponseSchema = z.object({ services: z.array(z.unknown()) });

const MonitorsResponseSchema = z.object({ monitors: z.array(z.unknown()) });

const AlertsResponseSchema = z.object({ alerts: z.array(z.unknown()) });

const AlertResponseSchema = z.object({ alert: z.unknown() });

const ChannelsResponseSchema = z.object({ channels: z.array(z.unknown()) });

const MonitorResponseSchema = z.object({ monitor: z.unknown() });

const OkResponseSchema = z.object({ ok: z.boolean() });

export interface RequestOptions {
  method?: string;
  body?: string;
}

export class KingletClient {
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(config: McpConfig) {
    this.baseUrl = config.url;
    this.key = config.key;
    this.timeoutMs = config.timeoutMs;
    this.userAgent = config.userAgent;
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers = new Headers({
      authorization: `Bearer ${this.key}`,
      accept: "application/json",
      "user-agent": this.userAgent,
    });

    const requestInit: RequestInit = {
      method: options.method ?? "GET",
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      requestInit.body = options.body;
    }

    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, requestInit);
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new KingletApiError(`Kinglet did not respond within ${this.timeoutMs}ms`);
      }

      throw new KingletApiError("could not reach the Kinglet server (check KINGLET_URL)");
    }

    const text = await response.text();
    let payload: JsonValue = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.ok) throw protocolError();
      }
    }

    if (!response.ok) throw httpError(response.status, payload);

    const parsed = schema.safeParse(payload);

    if (!parsed.success) throw protocolError();

    return parsed.data;
  }

  async getContext(): Promise<KeyContext> {
    return this.request("/v1/context", ContextSchema);
  }

  async searchEvents(params: SearchEventsParams = {}): Promise<SearchEventsResult> {
    const query = new URLSearchParams();
    const limit = Math.min(MAX_ROWS, Math.max(1, Math.trunc(params.limit ?? DEFAULT_ROWS)));

    if (params.q) query.set("q", params.q);

    if (params.from !== undefined) query.set("from", String(params.from));

    if (params.to !== undefined) query.set("to", String(params.to));
    query.set("limit", String(limit));

    if (params.cursor !== undefined) query.set("cursor", String(params.cursor));

    const response = await this.request(`/v1/events?${query.toString()}`, EventsResponseSchema);

    return {
      events: response.events.flatMap((row): ClientEvent[] => {
        const parsed = EventSchema.safeParse(row);

        return parsed.success ? [toClientEvent(parsed.data)] : [];
      }),
      nextCursor: response.nextCursor,
    };
  }

  async getEvent(uid: string): Promise<ClientEvent | null> {
    const response = await this.request(
      `/v1/events/${encodeURIComponent(uid)}`,
      EventResponseSchema,
    );

    const parsed = EventSchema.safeParse(response.event);

    if (!parsed.success) throw protocolError();

    return toClientEvent(parsed.data);
  }

  async getEventContext(uid: string, before = 5, after = 5): Promise<EventContextResult | null> {
    const boundedBefore = Math.min(20, Math.max(0, Math.trunc(before)));
    const boundedAfter = Math.min(20, Math.max(0, Math.trunc(after)));
    let response: z.infer<typeof EventContextResponseSchema>;

    try {
      response = await this.request(
        `/v1/events/${encodeURIComponent(uid)}/context?before=${boundedBefore}&after=${boundedAfter}`,
        EventContextResponseSchema,
      );
    } catch (err) {
      if (err instanceof KingletApiError && err.status === 404) return null;

      throw err;
    }

    const parsed = EventSchema.safeParse(response.event);

    if (!parsed.success) throw protocolError();

    return {
      event: toClientEvent(parsed.data),
      before: response.before.flatMap((row): ClientEvent[] => {
        const neighbour = EventSchema.safeParse(row);

        return neighbour.success ? [toClientEvent(neighbour.data)] : [];
      }),
      after: response.after.flatMap((row): ClientEvent[] => {
        const neighbour = EventSchema.safeParse(row);

        return neighbour.success ? [toClientEvent(neighbour.data)] : [];
      }),
    };
  }

  async getHistogram(
    params: {
      from?: number;
      to?: number;
      buckets?: number;
    } = {},
  ): Promise<HistogramResult> {
    const query = new URLSearchParams();

    if (params.from !== undefined) query.set("from", String(params.from));

    if (params.to !== undefined) query.set("to", String(params.to));

    if (params.buckets !== undefined) query.set("buckets", String(params.buckets));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await this.request(`/v1/histogram${suffix}`, HistogramResponseSchema);

    return {
      from: response.from,
      to: response.to,
      bucketMs: response.bucketMs,
      points: response.points.flatMap((point): HistogramPoint[] => {
        const parsed = HistogramPointSchema.safeParse(point);

        return parsed.success ? [parsed.data] : [];
      }),
    };
  }

  async listServices(): Promise<ServiceInfo[]> {
    const response = await this.request("/v1/services", ServicesResponseSchema);

    return response.services.flatMap((row): ServiceInfo[] => {
      const parsed = ServiceSchema.safeParse(row);

      return parsed.success ? [parsed.data] : [];
    });
  }

  async aggregateEvents(params: AggregateEventsParams = {}): Promise<AggregateEventsResult> {
    const query = new URLSearchParams();

    if (params.q) query.set("q", params.q);

    if (params.from !== undefined) query.set("from", String(params.from));

    if (params.to !== undefined) query.set("to", String(params.to));

    if (params.groupBy !== undefined) query.set("groupBy", params.groupBy);
    const limit = Math.min(MAX_ROWS, Math.max(1, Math.trunc(params.limit ?? DEFAULT_ROWS)));

    query.set("limit", String(limit));

    const response = await this.request(
      `/v1/aggregate?${query.toString()}`,
      AggregateResponseSchema,
    );

    const result: AggregateEventsResult = {
      from: response.from,
      to: response.to,
      total: response.total,
    };

    if (response.groupBy !== undefined) {
      result.groupBy = response.groupBy;
      result.groups = (response.groups ?? []).flatMap((row): AggregateGroup[] => {
        const parsed = AggregateGroupSchema.safeParse(row);

        return parsed.success ? [parsed.data] : [];
      });
    }

    if (response.truncated === true) result.truncated = true;

    return result;
  }

  async listMonitors(): Promise<MonitorInfo[]> {
    const response = await this.request("/v1/monitors", MonitorsResponseSchema);

    return response.monitors.flatMap((row): MonitorInfo[] => {
      const parsed = MonitorSchema.safeParse(row);

      return parsed.success ? [toMonitorInfo(parsed.data)] : [];
    });
  }

  /**
   * There is no GET /v1/monitors/:id route, so a single monitor is resolved
   * from the project's list. The list is bounded (100 per project).
   */
  async getMonitor(id: string): Promise<MonitorInfo | null> {
    const monitors = await this.listMonitors();

    return monitors.find((monitor) => monitor.id === id) ?? null;
  }

  async listAlerts(params: ListAlertsParams = {}): Promise<AlertInfo[]> {
    const bounded = Math.min(MAX_ROWS, Math.max(1, Math.trunc(params.limit ?? DEFAULT_ROWS)));
    const query = new URLSearchParams({ limit: String(bounded) });

    if (params.monitorId !== undefined) query.set("monitorId", params.monitorId);

    if (params.state !== undefined) query.set("state", params.state);

    if (params.from !== undefined) query.set("from", String(params.from));

    if (params.to !== undefined) query.set("to", String(params.to));

    const response = await this.request(`/v1/alerts?${query.toString()}`, AlertsResponseSchema);

    return response.alerts.flatMap((row): AlertInfo[] => {
      const parsed = AlertSchema.safeParse(row);

      return parsed.success ? [toAlertInfo(parsed.data)] : [];
    });
  }

  async getAlert(id: string): Promise<AlertInfo | null> {
    let response: z.infer<typeof AlertResponseSchema>;

    try {
      response = await this.request(`/v1/alerts/${encodeURIComponent(id)}`, AlertResponseSchema);
    } catch (err) {
      // A missing or cross-project alert is a normal not-found, not an error.
      if (err instanceof KingletApiError && err.status === 404) return null;

      throw err;
    }

    const parsed = AlertSchema.safeParse(response.alert);

    if (!parsed.success) throw protocolError();

    return toAlertInfo(parsed.data);
  }

  async listChannels(): Promise<ChannelSummary[]> {
    const response = await this.request(
      "/v1/notifications/channels/summary",
      ChannelsResponseSchema,
    );

    return response.channels.flatMap((row): ChannelSummary[] => {
      const parsed = ChannelSchema.safeParse(row);

      return parsed.success ? [toChannelSummary(parsed.data)] : [];
    });
  }

  async createMonitor(input: MonitorInput): Promise<MonitorInfo> {
    const response = await this.request("/v1/monitors", MonitorResponseSchema, {
      method: "POST",
      body: JSON.stringify(monitorBody(input)),
    });

    const parsed = MonitorSchema.safeParse(response.monitor);

    if (!parsed.success) throw protocolError();

    return toMonitorInfo(parsed.data);
  }

  async updateMonitor(id: string, patch: MonitorInput): Promise<MonitorInfo> {
    const response = await this.request(
      `/v1/monitors/${encodeURIComponent(id)}`,
      MonitorResponseSchema,
      { method: "PATCH", body: JSON.stringify(monitorBody(patch)) },
    );

    const parsed = MonitorSchema.safeParse(response.monitor);

    if (!parsed.success) throw protocolError();

    return toMonitorInfo(parsed.data);
  }

  async deleteMonitor(id: string): Promise<void> {
    const response = await this.request(
      `/v1/monitors/${encodeURIComponent(id)}`,
      OkResponseSchema,
      { method: "DELETE" },
    );

    if (!response.ok) throw protocolError();
  }
}

export interface MonitorBody {
  name?: string;
  query?: string;
  kind?: MonitorKind;
  threshold?: number;
  windowMs?: number;
  intervalMs?: number;
  cooldownMs?: number;
  enabled?: boolean;
  channelIds?: string[];
}

function monitorBody(input: MonitorInput): MonitorBody {
  const body: MonitorBody = {};

  if (input.name !== undefined) body.name = input.name;

  if (input.query !== undefined) body.query = input.query;

  if (input.kind !== undefined) body.kind = input.kind;

  if (input.threshold !== undefined) body.threshold = input.threshold;

  if (input.windowMs !== undefined) body.windowMs = input.windowMs;

  if (input.intervalMs !== undefined) body.intervalMs = input.intervalMs;

  if (input.cooldownMs !== undefined) body.cooldownMs = input.cooldownMs;

  if (input.enabled !== undefined) body.enabled = input.enabled;

  if (input.channelIds !== undefined) body.channelIds = [...input.channelIds];

  return body;
}
