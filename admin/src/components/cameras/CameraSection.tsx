import { Skeleton } from '@/components/ui/skeleton';
import type { Court, EndOption, Recording } from '@/api/types';
import { activeRecordingFor } from '@/api/client';
import { CameraCard } from './CameraCard';

interface Props {
  courts: Court[] | undefined;
  endOptions: EndOption[];
  recordings: Recording[];
  busy: boolean;
  onStart: (courtId: string, bookedUntil?: number) => void;
  onStop: (recordingId: string) => void;
}

export function CameraSection({ courts, endOptions, recordings, busy, onStart, onStop }: Props) {
  return (
    <section className="grid gap-4">
      <h2 className="text-lg font-medium">Cameras</h2>

      {courts === undefined ? (
        <div className="grid gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : courts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No cameras assigned to this venue yet. Once a camera is installed, ask
          your Padel Smart-Cam contact to assign it here.
        </p>
      ) : (
        <div className="grid gap-3">
          {courts.map((court) => (
            <CameraCard
              key={court.courtId}
              court={court}
              endOptions={endOptions}
              activeRecording={activeRecordingFor(court, recordings)}
              busy={busy}
              onStart={onStart}
              onStop={onStop}
            />
          ))}
        </div>
      )}
    </section>
  );
}
