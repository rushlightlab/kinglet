/** In-process operational status, surfaced by /healthz and the API. */
export const systemStatus = {
  startedAt: Date.now(),
  retentionLastRunAt: null as number | null,
  retentionLastError: null as string | null,
  monitorRefreshAt: null as number | null,
  monitorRefreshError: null as string | null,
};
