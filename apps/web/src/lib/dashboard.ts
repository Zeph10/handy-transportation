// Dashboard calculations. Pure (unit-tested with node).
import { addDays, localToInstant } from '../../../../core/src/index.ts';
import type { LocalDate, ResolvedSegment } from '../../../../core/src/index.ts';

export interface HeatCell { confirmed: number; tentative: number }

/**
 * Drivers available for each hour of a 7-day week. A driver counts for an hour
 * only when that whole hour is covered (AVAILABLE → confirmed; any TENTATIVE
 * part → tentative). UNKNOWN never counts.
 */
export function weeklyHeatmap(monday: LocalDate, timelines: ResolvedSegment[][]): HeatCell[][] {
  const grid: HeatCell[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ confirmed: 0, tentative: 0 })));
  for (let d = 0; d < 7; d++) {
    const date = addDays(monday, d);
    for (let h = 0; h < 24; h++) {
      const start = localToInstant(date, `${String(h).padStart(2, '0')}:00`);
      const end = h === 23 ? localToInstant(addDays(date, 1), '00:00') : localToInstant(date, `${String(h + 1).padStart(2, '0')}:00`);
      if (end <= start) continue; // nonexistent hour (spring forward)
      for (const tl of timelines) {
        const parts = tl.filter((s) => s.end > start && s.start < end);
        let covered = start;
        let tentative = false;
        let ok = true;
        for (const s of parts) {
          if (s.start > covered) { ok = false; break; }
          if (s.status === 'AVAILABLE' || s.status === 'TENTATIVE') {
            if (s.status === 'TENTATIVE') tentative = true;
            covered = Math.max(covered, s.end);
          } else { ok = false; break; }
        }
        if (!ok || covered < end) continue;
        if (tentative) grid[d][h].tentative++;
        else grid[d][h].confirmed++;
      }
    }
  }
  return grid;
}

/** True when the timeline has any AVAILABLE or TENTATIVE time. */
export function hasAnyAvailability(tl: ResolvedSegment[]): boolean {
  return tl.some((s) => s.status === 'AVAILABLE' || s.status === 'TENTATIVE');
}
