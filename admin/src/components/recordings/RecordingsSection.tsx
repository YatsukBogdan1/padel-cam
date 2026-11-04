import { Skeleton } from '@/components/ui/skeleton';
import type { Recording } from '@/api/types';
import { RecordingCards } from './RecordingCards';
import { RecordingsTable } from './RecordingsTable';

interface Props {
  recordings: Recording[] | undefined;
  busy: boolean;
  onShare: (recordingId: string) => void;
}

export function RecordingsSection({ recordings, busy, onShare }: Props) {
  return (
    <section className="grid gap-4">
      <h2 className="text-lg font-medium">Recordings</h2>

      {recordings === undefined ? (
        <Skeleton className="h-40 w-full" />
      ) : recordings.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing recorded yet. Start a camera above.
        </p>
      ) : (
        <>
          {/* Cards on a phone, table from sm up — see RecordingCards for why. */}
          <div className="sm:hidden">
            <RecordingCards recordings={recordings} busy={busy} onShare={onShare} />
          </div>
          <div className="hidden sm:block">
            <RecordingsTable recordings={recordings} busy={busy} onShare={onShare} />
          </div>
        </>
      )}
    </section>
  );
}
