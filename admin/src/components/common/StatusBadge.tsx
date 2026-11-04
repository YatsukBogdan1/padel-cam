import { Badge } from '@/components/ui/badge';
import type { RecordingStatus } from '@/api/types';

const VARIANT: Record<RecordingStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  recording: 'destructive', // live — the one state that should catch the eye
  uploading: 'secondary',
  ready: 'default',
  expired: 'outline',
  failed: 'destructive',
};

const LABEL: Record<RecordingStatus, string> = {
  recording: 'Recording',
  uploading: 'Uploading',
  ready: 'Ready',
  expired: 'Expired',
  failed: 'Failed',
};

/**
 * `reason` is the recording's `error`, shown on hover. A failed capture used to
 * be indistinguishable from any other failure, which meant the one case that
 * matters — something else on the Pi still holding the camera — looked exactly
 * like a network problem.
 */
export function StatusBadge({
  status,
  reason,
}: {
  status: RecordingStatus;
  reason?: string | null;
}) {
  return (
    <Badge variant={VARIANT[status]} title={reason ?? undefined}>
      {LABEL[status]}
    </Badge>
  );
}

export function OnlineBadge({ online }: { online: boolean }) {
  return (
    <Badge variant={online ? 'default' : 'outline'}>
      <span
        className={`mr-1.5 inline-block size-1.5 rounded-full ${
          online ? 'bg-emerald-400' : 'bg-muted-foreground'
        }`}
      />
      {online ? 'Online' : 'Offline'}
    </Badge>
  );
}
