import { Download, QrCode } from 'lucide-react';
import { StatusBadge } from '@/components/common/StatusBadge';
import { Thumbnail } from '@/components/common/Thumbnail';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';
import type { Recording } from '@/api/types';
import { formatBytes, formatDateTime, formatDuration, joinMeta } from '@/lib/format';

interface Props {
  recordings: Recording[];
  busy: boolean;
  onShare: (recordingId: string) => void;
}

/**
 * The phone layout for recordings.
 *
 * A six-column table on a 390px screen pushes Download and QR code off the
 * right edge, where they are reachable only by discovering that the card
 * scrolls sideways — so on a phone the club's two primary actions were
 * effectively missing. Cards put them full-width under each recording instead.
 *
 * Actions are sized for a fingertip (h-10) rather than reusing the desktop
 * table's compact h-7 buttons. Because this markup is mobile-only, that costs
 * the desktop layout nothing.
 */
export function RecordingCards({ recordings, busy, onShare }: Props) {
  return (
    <ul className="grid gap-3">
      {recordings.map((rec) => (
        <li key={rec.id} className="grid gap-3 rounded-lg border p-3">
          <div className="flex items-start gap-3">
            <Thumbnail recordingId={rec.id} thumbnailKey={rec.thumbnail_key} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{rec.court_id}</p>
              <p className="text-muted-foreground text-xs">
                {formatDateTime(rec.started_at)}
              </p>
              {joinMeta(
                formatDuration(rec.started_at, rec.stopped_at),
                formatBytes(rec.bytes),
              ) && (
                <p className="text-muted-foreground text-xs">
                  {joinMeta(
                    formatDuration(rec.started_at, rec.stopped_at),
                    formatBytes(rec.bytes),
                  )}
                </p>
              )}
            </div>
            <StatusBadge status={rec.status} reason={rec.error} />
          </div>

          {rec.status === 'failed' && rec.error && (
            <p className="text-muted-foreground text-xs">{rec.error}</p>
          )}

          <div className="grid grid-cols-2 gap-2">
            {rec.status === 'ready' ? (
              <Button variant="outline" className="h-10" asChild>
                <a href={api.downloadUrl(rec.id)} download>
                  <Download />
                  Download
                </a>
              </Button>
            ) : (
              <Button variant="outline" className="h-10" disabled>
                <Download />
                Download
              </Button>
            )}
            <Button
              className="h-10"
              disabled={busy || rec.status !== 'ready'}
              onClick={() => onShare(rec.id)}
            >
              <QrCode />
              QR code
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
