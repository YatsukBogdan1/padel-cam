import { QrCode, Trash2 } from 'lucide-react';
import { superApi } from '@/api/client';
import { OnlineBadge } from '@/components/common/StatusBadge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { FleetCourt, Venue } from '@/api/types';
import { formatRelative } from '@/lib/format';

interface Props {
  courts: FleetCourt[];
  venues: Venue[];
  busy: boolean;
  onAssign: (courtId: string, venueId: string | null) => void;
  onDelete: (courtId: string) => void;
}

/**
 * The camera-to-venue mapping, and the only place it can be changed. Clubs used
 * to do this themselves from their own dashboard, which meant any club could
 * adopt any camera that had not yet been claimed — including one just installed
 * at a different site.
 */
export function FleetCourts({ courts, venues, busy, onAssign, onDelete }: Props) {
  const confirmDelete = (courtId: string) => {
    if (
      window.confirm(
        `Delete the row for ${courtId}? It will reappear the next time that Pi connects.`,
      )
    ) {
      onDelete(courtId);
    }
  };

  return (
    <>
      {/* Phones: cards. The table's Presence, Last seen, Agent and Remove
          columns all fall off a 390px screen, which made deleting a court
          impossible on a phone. */}
      <ul className="grid gap-3 md:hidden">
        {courts.map((court) => (
          <li
            key={court.courtId}
            className={`grid gap-3 rounded-lg border p-3 ${court.venueId ? '' : 'bg-muted/40'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{court.courtId}</p>
                {court.name && (
                  <p className="text-muted-foreground truncate text-xs">{court.name}</p>
                )}
                <p className="text-muted-foreground text-xs">
                  Seen {formatRelative(court.lastSeen)} · {court.agentVersion ?? 'no version'}
                </p>
              </div>
              <OnlineBadge online={court.online} />
            </div>

            <div className="flex items-center gap-2">
              <select
                className="border-input bg-background h-10 min-w-0 flex-1 rounded-md border px-2 text-sm"
                disabled={busy}
                value={court.venueId ?? ''}
                onChange={(e) => onAssign(court.courtId, e.target.value || null)}
                aria-label={`Venue for ${court.courtId}`}
              >
                <option value="">— unassigned —</option>
                {venues.map((venue) => (
                  <option key={venue.id} value={venue.id}>
                    {venue.name}
                  </option>
                ))}
              </select>
              {court.venueId && (
                <Button variant="outline" className="h-10 px-3" asChild>
                  <a
                    href={superApi.qrCardUrl(court.courtId)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Print QR card for ${court.courtId}`}
                  >
                    <QrCode />
                  </a>
                </Button>
              )}
              <Button
                variant="outline"
                className="h-10 px-3"
                disabled={busy}
                onClick={() => confirmDelete(court.courtId)}
                aria-label={`Delete ${court.courtId}`}
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
            <TableHead>Camera</TableHead>
            <TableHead>Venue</TableHead>
            <TableHead>Presence</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>QR card</TableHead>
            <TableHead className="text-right">Remove</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {courts.map((court) => (
            <TableRow key={court.courtId} className={court.venueId ? undefined : 'bg-muted/40'}>
              <TableCell className="font-medium">
                {court.courtId}
                {court.name && (
                  <span className="text-muted-foreground ml-2 font-normal">{court.name}</span>
                )}
              </TableCell>

              <TableCell>
                <select
                  className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                  disabled={busy}
                  value={court.venueId ?? ''}
                  onChange={(e) => onAssign(court.courtId, e.target.value || null)}
                >
                  <option value="">— unassigned —</option>
                  {venues.map((venue) => (
                    <option key={venue.id} value={venue.id}>
                      {venue.name}
                    </option>
                  ))}
                </select>
              </TableCell>

              <TableCell>
                <OnlineBadge online={court.online} />
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {formatRelative(court.lastSeen)}
              </TableCell>
              <TableCell className="text-muted-foreground font-mono text-xs">
                {court.agentVersion ?? '—'}
              </TableCell>
              <TableCell>
                {court.venueId ? (
                  <Button variant="ghost" size="sm" asChild>
                    <a href={superApi.qrCardUrl(court.courtId)} target="_blank" rel="noreferrer">
                      <QrCode />
                      Print
                    </a>
                  </Button>
                ) : (
                  <span className="text-muted-foreground text-xs">assign first</span>
                )}
              </TableCell>

              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => confirmDelete(court.courtId)}
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
  );
}
