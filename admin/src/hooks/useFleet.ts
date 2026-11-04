import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { superApi } from '@/api/client';
import { usePoll } from './usePoll';

/** Slower than the venue dashboard: this page is for deliberate operations. */
const POLL_MS = 10_000;

/**
 * Fleet-wide state for the super-admin page. Mirrors useDashboard's shape on
 * purpose — poll, a busy flag that disables every control, and named actions —
 * so the two pages behave the same way under a slow network.
 */
export function useFleet(onApiError: (error: unknown) => void) {
  const fleet = usePoll(superApi.overview, POLL_MS);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: () => Promise<unknown>, success: string) => {
      setBusy(true);
      try {
        await action();
        toast.success(success);
        await fleet.refresh();
      } catch (error) {
        onApiError(error);
        toast.error(error instanceof Error ? error.message : 'Something went wrong');
      } finally {
        setBusy(false);
      }
    },
    [fleet, onApiError],
  );

  return {
    data: fleet.data,
    loading: fleet.loading,
    busy,

    assignCourt: (courtId: string, venueId: string | null) =>
      run(
        () => superApi.assignCourt(courtId, venueId),
        venueId ? `${courtId} assigned` : `${courtId} unassigned`,
      ),

    renameCourt: (courtId: string, name: string | null) =>
      run(() => superApi.renameCourt(courtId, name), `${courtId} renamed`),

    setFreeUntil: (courtId: string, freeUntil: number | null) =>
      run(
        () => superApi.setFreeUntil(courtId, freeUntil),
        freeUntil === null ? `${courtId} is free indefinitely` : `${courtId} free period set`,
      ),

    deleteCourt: (courtId: string) =>
      run(() => superApi.deleteCourt(courtId), `${courtId} deleted`),

    setVenueSchedule: (venueId: string, timezone: string, slotMinutes: number) =>
      run(
        () => superApi.setVenueSchedule(venueId, timezone, slotMinutes),
        'Booking grid saved',
      ),

    createVenue: (id: string, name: string) =>
      run(() => superApi.createVenue(id, name), `Venue "${name}" created`),

    cleanup: (ids?: string[]) =>
      run(async () => {
        const { count } = await superApi.cleanup(ids);
        if (count === 0) toast.message('Nothing to clean up');
      }, 'Cleanup finished'),

    purgeRecording: (id: string) =>
      run(() => superApi.purgeRecording(id), 'Recording deleted'),

    /** Delete footage outright. Sequential, so a mid-way failure is reported honestly. */
    purgeRecordings: (ids: string[]) =>
      run(async () => {
        for (const id of ids) await superApi.purgeRecording(id);
      }, `Deleted ${ids.length} recording(s)`),
  };
}
