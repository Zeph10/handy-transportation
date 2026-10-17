import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays } from '@handy/core';
import type { LocalDate } from '@handy/core';
import { fetchScheduleRows, listDestinationDefaults, listDestinations, listTemplates, listVehicles } from '@/lib/api';
import { scheduleFromRows } from '@/lib/convert';

export const qk = {
  destinations: ['destinations'] as const,
  vehicles: (d: string) => ['vehicles', d] as const,
  defaults: (d: string) => ['dest-defaults', d] as const,
  schedule: (d: string | null, from: string, to: string) => ['schedule', d ?? 'all', from, to] as const,
  templates: (d: string) => ['templates', d] as const,
};

/** Destinations, vehicles and rate defaults a driver needs everywhere. */
export function useDriverReference(driverId: string) {
  const destinations = useQuery({ queryKey: qk.destinations, queryFn: () => listDestinations(), staleTime: 5 * 60_000 });
  const vehicles = useQuery({ queryKey: qk.vehicles(driverId), queryFn: () => listVehicles(driverId) });
  const defaults = useQuery({ queryKey: qk.defaults(driverId), queryFn: () => listDestinationDefaults(driverId) });
  return {
    destinations: destinations.data ?? [],
    vehicles: vehicles.data ?? [],
    defaults: defaults.data ?? [],
    loading: destinations.isLoading || vehicles.isLoading || defaults.isLoading,
    error: destinations.error ?? vehicles.error ?? defaults.error,
  };
}

/** A driver's schedule for a local date range, converted to core types. */
export function useSchedule(driverId: string | null, from: LocalDate, to: LocalDate) {
  return useQuery({
    queryKey: qk.schedule(driverId, from, to),
    queryFn: async () => {
      const rows = await fetchScheduleRows(driverId, from, to);
      return { rows, schedule: scheduleFromRows(rows) };
    },
    placeholderData: (prev) => prev,
  });
}

export function useTemplates(driverId: string) {
  return useQuery({ queryKey: qk.templates(driverId), queryFn: () => listTemplates(driverId) });
}

/** Invalidate everything that depends on availability after a save. */
export function useInvalidateSchedule() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['schedule'] });
}

export function weekRange(monday: LocalDate): { from: LocalDate; to: LocalDate } {
  return { from: monday, to: addDays(monday, 6) };
}
