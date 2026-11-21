/** In-process operational status, surfaced by /healthz and the API. */
interface SystemStatus {
  startedAt: number;
  retentionLastRunAt: number | null;
  retentionLastError: string | null;
  monitorRefreshAt: number | null;
  monitorRefreshError: string | null;
}

export const systemStatus: SystemStatus = {
  startedAt: Date.now(),
  retentionLastRunAt: null,
  retentionLastError: null,
  monitorRefreshAt: null,
  monitorRefreshError: null,
};
