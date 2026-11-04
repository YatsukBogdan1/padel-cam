import { useState } from 'react';
import { Circle, Square } from 'lucide-react';
import { OnlineBadge } from '@/components/common/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { Court, EndOption, Recording } from '@/api/types';
import { formatRelative } from '@/lib/format';

interface Props {
  court: Court;
  endOptions: EndOption[];
  /** Set while a recording is in flight; `recording` flips the action to Stop. */
  activeRecording: Recording | undefined;
  busy: boolean;
  onStart: (courtId: string, bookedUntil?: number) => void;
  onStop: (recordingId: string) => void;
}

export function CameraCard({ court, endOptions, activeRecording, busy, onStart, onStop }: Props) {
  // '' = until stopped by hand (the server caps it at 3 h). Recorded matches
  // otherwise end on the booking grid, exactly as players' do.
  const [until, setUntil] = useState('');
  const isRecording = activeRecording?.status === 'recording';
  // Capture has stopped but parts are still draining. Neither action applies:
  // there is nothing left to stop, and starting again would race the upload.
  const isUploading = activeRecording?.status === 'uploading';

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate font-medium">{court.name ?? court.courtId}</p>
          <p className="text-muted-foreground text-xs">
            {court.online ? 'Connected' : `Last seen ${formatRelative(court.lastSeen)}`}
          </p>
        </div>

        {/*
          Start/Stop is the one control a club touches during a match, usually
          on a phone at the court side. The desktop `sm` button is a 28px target,
          well under the ~44px a fingertip needs, so it grows on small screens
          and only shrinks back at `sm:`.
        */}
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <OnlineBadge online={court.online} />
          {isUploading ? (
            <Button variant="outline" className="h-10 px-4 sm:h-7 sm:px-2.5" disabled>
              Finishing…
            </Button>
          ) : isRecording ? (
            <Button
              variant="destructive"
              className="h-10 px-4 sm:h-7 sm:px-2.5"
              disabled={busy}
              onClick={() => onStop(activeRecording!.id)}
            >
              <Square />
              Stop
            </Button>
          ) : (
            <>
            <select
              className="border-input bg-background h-10 rounded-md border px-2 text-sm sm:h-7"
              value={until}
              disabled={busy || !court.online}
              onChange={(e) => setUntil(e.target.value)}
              aria-label={`Record ${court.name ?? court.courtId} until`}
            >
              <option value="">Until stopped</option>
              {endOptions.map((o) => (
                <option key={o.at} value={o.at}>
                  Until {o.label}
                </option>
              ))}
            </select>
            <Button
              className="h-10 px-4 sm:h-7 sm:px-2.5"
              disabled={busy || !court.online}
              onClick={() => onStart(court.courtId, until ? Number(until) : undefined)}
            >
              <Circle />
              Start
            </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
