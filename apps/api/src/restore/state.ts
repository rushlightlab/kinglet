/**
 * In-process maintenance gate for a staged restore.
 *
 * A restore cannot swap the live database while the server is serving writes,
 * so staging flips this flag once the snapshot is fully verified. The server
 * uses it to reject ingest/mutations and pause background jobs; it does not
 * persist and resets on restart, when the boot swap runs instead.
 */

export interface MaintenanceStatus {
  active: boolean;
  reason: string | null;
}

let current: MaintenanceStatus = { active: false, reason: null };

export function beginMaintenance(reason: string): void {
  const text = reason.trim();

  current = { active: true, reason: text === "" ? "maintenance" : text };
}

export function endMaintenance(): void {
  current = { active: false, reason: null };
}

export function maintenanceState(): MaintenanceStatus {
  return { active: current.active, reason: current.reason };
}
