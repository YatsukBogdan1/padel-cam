import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { ShareLink } from '@/api/types';
import { usePoll } from './usePoll';

/** Cameras go on/offline and recordings change state without any push channel. */
const POLL_MS = 5_000;

/**
 * Owns everything the signed-in dashboard needs: polled data, the in-flight flag
 * that disables buttons, and the three actions. Keeping it here leaves App.tsx
 * as pure composition.
 */
export function useDashboard(onApiError: (error: unknown) => void) {
  const courts = usePoll(api.courts, POLL_MS);
  const recordings = usePoll(api.recordings, POLL_MS);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<ShareLink>();

  const run = useCallback(
    async (action: () => Promise<unknown>, success?: string) => {
      setBusy(true);
      try {
        await action();
        if (success) toast.success(success);
        // Refresh both: starting a recording changes a camera's state too.
        await Promise.all([courts.refresh(), recordings.refresh()]);
      } catch (error) {
        onApiError(error);
        toast.error(error instanceof Error ? error.message : 'Something went wrong');
      } finally {
        setBusy(false);
      }
    },
    [courts, recordings, onApiError],
  );

  const startRecording = useCallback(
    (courtId: string, bookedUntil?: number) =>
      run(() => api.startRecording(courtId, bookedUntil), 'Recording started'),
    [run],
  );

  const stopRecording = useCallback(
    (recordingId: string) => run(() => api.stopRecording(recordingId), 'Recording stopped'),
    [run],
  );

  const shareRecording = useCallback(
    (recordingId: string) =>
      run(async () => {
        setShare(await api.createShare(recordingId));
      }),
    [run],
  );

  return {
    courts: courts.data?.courts,
    endOptions: courts.data?.endOptions ?? [],
    recordings: recordings.data,
    busy,
    share,
    closeShare: () => setShare(undefined),
    startRecording,
    stopRecording,
    shareRecording,
  };
}
