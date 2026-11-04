import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { StatusBadge } from '@/components/common/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ActiveRecording } from '@/api/types';
import { formatBytes, formatRelative, joinMeta } from '@/lib/format';

interface Props {
  active: ActiveRecording[];
  busy: boolean;
  onCleanup: (ids?: string[]) => void;
  onPurge: (id: string) => void;
}

/**
 * Recordings that never reached a terminal state. Each one still holds an open
 * R2 multipart upload, which is billed and does not appear in a bucket listing —
 * so left alone they accumulate invisibly.
 *
 * "Clean up" aborts that upload and marks the row failed, which is what the
 * nightly sweep does; rows tagged `stale` are the ones the sweep would take
 * right now. Anything not tagged is probably a healthy recording in progress,
 * which is why forcing one requires selecting it by hand.
 */
export function CleanupCard({ active, busy, onCleanup, onPurge }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const staleCount = active.filter((r) => r.stale).length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <Card>
      <CardHeader className="gap-3">
        <CardTitle>
          In-flight recordings
          {staleCount > 0 && (
            <Badge variant="destructive" className="ml-2">
              {staleCount} stale
            </Badge>
          )}
        </CardTitle>
        <CardAction className="col-start-1 row-start-2 flex flex-wrap gap-2 sm:col-start-2 sm:row-start-1">
          {selected.size > 0 && (
            <Button
              variant="destructive"
              className="h-10 sm:h-7 sm:px-2.5"
              disabled={busy}
              onClick={() => {
                onCleanup([...selected]);
                setSelected(new Set());
              }}
            >
              Clean up {selected.size} selected
            </Button>
          )}
          <Button
            variant="outline"
            className="h-10 sm:h-7 sm:px-2.5"
            disabled={busy || staleCount === 0}
            onClick={() => onCleanup()}
          >
            Sweep stale
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent>
        {active.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing in flight. Every recording has reached a final state.
          </p>
        ) : (
          <>
          {/* Phones: cards. Status was clipped and the per-row delete sat
              entirely off a 390px screen. */}
          <ul className="grid gap-2 md:hidden">
            {active.map((rec) => (
              <li
                key={rec.id}
                className={`flex items-start gap-3 rounded-lg border p-3 ${
                  rec.stale ? 'bg-destructive/5' : ''
                }`}
              >
                <input
                  type="checkbox"
                  aria-label={`Select recording ${rec.id}`}
                  className="mt-1 size-5 shrink-0"
                  checked={selected.has(rec.id)}
                  onChange={() => toggle(rec.id)}
                  disabled={busy}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{rec.court_id}</p>
                  <p className="text-muted-foreground text-xs">
                    {joinMeta(formatRelative(rec.started_at), formatBytes(rec.bytes))}
                  </p>
                  {rec.stale && <p className="text-destructive text-xs">abandoned</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <StatusBadge status={rec.status} />
                  <Button
                    variant="ghost"
                    className="h-10 px-2"
                    disabled={busy}
                    aria-label={`Delete recording ${rec.id}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          'Permanently delete this recording and its video? This cannot be undone.',
                        )
                      ) {
                        onPurge(rec.id);
                      }
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Court</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Delete</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {active.map((rec) => (
                  <TableRow key={rec.id} className={rec.stale ? 'bg-destructive/5' : undefined}>
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
                    <TableCell className="font-medium">{rec.court_id}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatRelative(rec.started_at)}
                    </TableCell>
                    <TableCell className="tabular-nums">{formatBytes(rec.bytes)}</TableCell>
                    <TableCell className="flex items-center gap-2">
                      <StatusBadge status={rec.status} />
                      {rec.stale && (
                        <span className="text-destructive text-xs">abandoned</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Permanently delete this recording and its video? ` +
                                `This cannot be undone.`,
                            )
                          ) {
                            onPurge(rec.id);
                          }
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
