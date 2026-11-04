import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { StatusBadge } from '@/components/common/StatusBadge';
import { Thumbnail } from '@/components/common/Thumbnail';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { FleetRecording } from '@/api/types';
import { formatBytes, formatDateTime, formatDuration, joinMeta } from '@/lib/format';

interface Props {
  recordings: FleetRecording[];
  busy: boolean;
  onPurge: (ids: string[]) => void;
}

/**
 * Every recording in the fleet, and the only place footage is deleted.
 *
 * Deliberately not the R2 console: there, objects are opaque keys with no court,
 * date or venue next to them, so the safest-looking action — deleting the wrong
 * one — is unrecoverable. Here a frame, a court and a timestamp are visible at
 * the moment of choosing, and deleting takes the D1 row, the video, the
 * thumbnail and any share links together, so nothing is orphaned.
 */
export function AllRecordingsCard({ recordings, busy, onPurge }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  const query = filter.trim().toLowerCase();
  const shown = query
    ? recordings.filter(
        (r) =>
          r.court_id.toLowerCase().includes(query) ||
          r.status.includes(query) ||
          (r.venue_id ?? '').toLowerCase().includes(query),
      )
    : recordings;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Only what is both selected and currently visible, so a filtered-out
  // selection can never be deleted by a button the operator cannot see.
  const selectedShown = shown.filter((r) => selected.has(r.id));
  const allShownSelected = shown.length > 0 && selectedShown.length === shown.length;

  function confirmPurge() {
    const ids = selectedShown.map((r) => r.id);
    const bytes = selectedShown.reduce((sum, r) => sum + r.bytes, 0);
    const ok = window.confirm(
      `Permanently delete ${ids.length} recording(s) — ${formatBytes(bytes)} of video?\n\n` +
        `The video, its thumbnail and any share links you handed to players are ` +
        `removed. This cannot be undone.`,
    );
    if (!ok) return;
    onPurge(ids);
    setSelected(new Set());
  }

  return (
    <Card>
      {/* The header stacks on phones: a 224px filter box beside a title beside a
          button does not fit 390px, and the Delete button was clipped off the
          right edge — the one control this card exists for. */}
      <CardHeader className="gap-3 sm:has-data-[slot=card-action]:grid-cols-[1fr_auto]">
        <CardTitle>All recordings</CardTitle>
        <CardAction className="col-start-1 row-start-2 flex items-center gap-2 sm:col-start-2 sm:row-start-1">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by court, venue, status"
            className="h-10 min-w-0 flex-1 sm:h-8 sm:w-56 sm:flex-none"
          />
          <Button
            variant="destructive"
            className="h-10 shrink-0 px-3 sm:h-7 sm:px-2.5"
            disabled={busy || selectedShown.length === 0}
            onClick={confirmPurge}
          >
            <Trash2 />
            Delete {selectedShown.length > 0 ? selectedShown.length : ''}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent>
        {shown.length > 0 && (
          <label className="mb-3 flex items-center gap-2 text-sm md:hidden">
            <input
              type="checkbox"
              className="size-5"
              checked={allShownSelected}
              onChange={() =>
                setSelected(allShownSelected ? new Set() : new Set(shown.map((r) => r.id)))
              }
              disabled={busy}
            />
            Select all {shown.length} shown
          </label>
        )}
        {shown.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {recordings.length === 0 ? 'No recordings yet.' : 'Nothing matches that filter.'}
          </p>
        ) : (
          <>
          {/* Phones: cards. Venue, size and status all fall off the right of a
              390px screen, and picking footage to delete without seeing its
              status or size is exactly the mistake this card exists to prevent. */}
          <ul className="grid gap-2 md:hidden">
            {shown.map((rec) => (
              <li key={rec.id} className="flex items-start gap-3 rounded-lg border p-3">
                <input
                  type="checkbox"
                  aria-label={`Select recording ${rec.id}`}
                  className="mt-1 size-5 shrink-0"
                  checked={selected.has(rec.id)}
                  onChange={() => toggle(rec.id)}
                  disabled={busy}
                />
                <Thumbnail recordingId={rec.id} thumbnailKey={rec.thumbnail_key} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{rec.court_id}</p>
                  <p className="text-muted-foreground text-xs">
                    {rec.venue_id ?? 'unassigned'} · {formatDateTime(rec.started_at)}
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
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all shown"
                      className="size-4 align-middle"
                      checked={allShownSelected}
                      onChange={() =>
                        setSelected(allShownSelected ? new Set() : new Set(shown.map((r) => r.id)))
                      }
                      disabled={busy}
                    />
                  </TableHead>
                  <TableHead className="w-20">Frame</TableHead>
                  <TableHead>Court</TableHead>
                  <TableHead>Venue</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Length</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((rec) => (
                  <TableRow key={rec.id} data-state={selected.has(rec.id) ? 'selected' : undefined}>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`Select recording ${rec.id}`}
                        className="size-4 align-middle"
                        checked={selected.has(rec.id)}
                        onChange={() => toggle(rec.id)}
                        disabled={busy}
                      />
                    </TableCell>
                    <TableCell>
                      <Thumbnail recordingId={rec.id} thumbnailKey={rec.thumbnail_key} />
                    </TableCell>
                    <TableCell className="font-medium">{rec.court_id}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {rec.venue_id ?? '—'}
                    </TableCell>
                    <TableCell className="text-sm">{formatDateTime(rec.started_at)}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatDuration(rec.started_at, rec.stopped_at)}
                    </TableCell>
                    <TableCell className="tabular-nums">{formatBytes(rec.bytes)}</TableCell>
                    <TableCell>
                      <StatusBadge status={rec.status} reason={rec.error} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          </>
        )}

        <p className="text-muted-foreground mt-3 text-xs">
          Frames are generated by{' '}
          <code className="font-mono">worker/scripts/make-thumbnails.mjs</code>; recordings
          without one show a placeholder.
        </p>
      </CardContent>
    </Card>
  );
}
