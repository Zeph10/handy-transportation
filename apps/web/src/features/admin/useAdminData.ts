import { useQuery } from '@tanstack/react-query';
import { addDays, localToInstant } from '@handy/core';
import type { LocalDate } from '@handy/core';
import {
  fetchScheduleRows, getSettings, listActiveOverrides, listAllDestinationDefaults, listAllVehicles, listDestinations, listDrivers, listReservations, syncStatus,
} from '@/lib/api';
import { scheduleFromRows } from '@/lib/convert';
import type { DriverSchedule } from '@/lib/convert';
import type { AdminDataset } from '@/lib/matchInputs';
import type { ScheduleRows } from '@/lib/api';

function groupByDriver(rows: ScheduleRows, driverIds: string[]): Map<string, DriverSchedule> {
  const ruleOwner = new Map(rows.rules.map((r) => [r.id, r.driver_id]));
  const out = new Map<string, DriverSchedule>();
  for (const id of driverIds) {
    out.set(id, scheduleFromRows({
      blocks: rows.blocks.filter((b) => b.driver_id === id),
      rules: rows.rules.filter((r) => r.driver_id === id),
      exceptions: rows.exceptions.filter((e) => ruleOwner.get(e.rule_id) === id),
      timeOff: rows.timeOff.filter((t) => t.driver_id === id),
      adminUnavailable: rows.adminUnavailable.filter((a) => a.driver_id === id),
    }));
  }
  return out;
}

/** Everything the admin screens need for a local date range, as one dataset. */
export function useAdminDataset(from: LocalDate, to: LocalDate) {
  return useQuery({
    queryKey: ['admin-dataset', from, to],
    queryFn: async (): Promise<AdminDataset & { scheduleRows: ScheduleRows }> => {
      const [settings, destinations, drivers, vehicles, defaults, rows, reservations, overrides] = await Promise.all([
        getSettings(), listDestinations(true), listDrivers(), listAllVehicles(), listAllDestinationDefaults(),
        fetchScheduleRows(null, addDays(from, -1), addDays(to, 1)),
        listReservations(new Date(localToInstant(addDays(from, -1), '00:00')).toISOString(), new Date(localToInstant(addDays(to, 2), '00:00')).toISOString()),
        listActiveOverrides(),
      ]);
      return {
        settings, destinations, drivers, vehicles, defaults, reservations, overrides,
        schedules: groupByDriver(rows, drivers.map((d) => d.user_id)),
        scheduleRows: rows,
      };
    },
    placeholderData: (prev) => prev,
  });
}

export function useSyncStatus() {
  return useQuery({ queryKey: ['sync-status'], queryFn: syncStatus, refetchInterval: (q) => (q.state.data?.running ? 3000 : 60_000) });
}
