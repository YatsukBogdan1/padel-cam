import { useState } from 'react';
import { Film } from 'lucide-react';
import { api } from '@/api/client';

interface Props {
  recordingId: string;
  /** Null when no thumbnail has been generated for this recording. */
  thumbnailKey: string | null;
}

/**
 * First frame of a recording, or a neutral placeholder.
 *
 * Thumbnails are generated after the fact by worker/scripts/make-thumbnails.mjs,
 * so a recording legitimately has none until that runs — and `failed` and
 * `expired` rows never will. The placeholder is the normal case, not an error,
 * which is why nothing here looks like a broken image.
 *
 * `onError` covers the third case: the row still names a key whose object has
 * since been deleted.
 */
export function Thumbnail({ recordingId, thumbnailKey }: Props) {
  const [broken, setBroken] = useState(false);

  if (!thumbnailKey || broken) {
    return (
      <div className="bg-muted text-muted-foreground flex h-10 w-16 items-center justify-center rounded">
        <Film className="size-4 opacity-50" />
      </div>
    );
  }

  return (
    <img
      src={api.thumbnailUrl(recordingId)}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className="bg-muted h-10 w-16 rounded object-cover"
    />
  );
}
