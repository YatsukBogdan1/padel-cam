import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { CourtEngagement, FleetCourt } from '@/api/types';

interface Props {
  courts: FleetCourt[];
  engagement: CourtEngagement[];
  busy: boolean;
  onSetFreeUntil: (courtId: string, freeUntil: number | null) => void;
}

/** `YYYY-MM-DD` in local time, the format a date input speaks. */
function toDateInput(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight at the start of the chosen day: that day is the first paid one. */
function fromDateInput(value: string): number | null {
  return value ? new Date(`${value}T00:00`).getTime() : null;
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

/**
 * The free-period experiment: matches recorded before the chosen day stay free
 * for good, later ones are locked on the player's share page. The counts next to
 * it are the point -- a free period nobody downloads from answers the question
 * "do players care" before any payment flow gets built.
 */
export function FreePeriodCard({ courts, engagement, busy, onSetFreeUntil }: Props) {
  const assigned = courts.filter((c) => c.venueId !== null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const stats = new Map(engagement.map((e) => [e.court_id, e]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Free period</CardTitle>
        <p className="text-muted-foreground text-sm">
          Matches started before the chosen day stay free permanently; from that day on,
          players see a locked page. Empty means free indefinitely. Club staff can always
          download.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        {assigned.length === 0 && (
          <p className="text-muted-foreground text-sm">No cameras are assigned to a venue.</p>
        )}
        {assigned.map((court) => {
          const saved = toDateInput(court.freeUntil);
          const draft = drafts[court.courtId] ?? saved;
          const s = stats.get(court.courtId);
          return (
            <div key={court.courtId} className="grid gap-3 rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{court.courtId}</p>
                  <p className="text-muted-foreground text-xs">{court.venueName}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="date"
                    className="h-9 w-40"
                    value={draft}
                    disabled={busy}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [court.courtId]: e.target.value }))
                    }
                    aria-label={`First paid day for ${court.courtId}`}
                  />
                  <Button
                    size="sm"
                    disabled={busy || draft === saved}
                    onClick={() => onSetFreeUntil(court.courtId, fromDateInput(draft))}
                  >
                    Save
                  </Button>
                </div>
              </div>

              {s && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                  <Stat label="Recordings" value={s.recordings} />
                  <Stat label="Started by players" value={s.player_matches} />
                  <Stat
                    label="Link shared"
                    value={`${s.shared_matches} (${percent(s.shared_matches, s.player_matches)})`}
                  />
                  <Stat
                    label="Downloaded by players"
                    value={`${s.downloaded_recordings} (${percent(s.downloaded_recordings, s.recordings)})`}
                  />
                  <Stat label="Page views" value={s.views} />
                  <Stat label="Player downloads" value={s.downloads} />
                  <Stat label="Locked page views" value={s.locked_views} />
                  <Stat label="Staff downloads" value={s.admin_downloads} />
                </dl>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
