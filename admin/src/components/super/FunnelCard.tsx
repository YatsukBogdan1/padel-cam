import { useEffect, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { superApi } from '@/api/client';
import type { CourtFunnel, FleetCourt } from '@/api/types';
import { usePoll } from '@/hooks/usePoll';
import { formatDateTime } from '@/lib/format';

interface Props {
  courts: FleetCourt[];
}

/** Matches don't happen per second; a minute is plenty. */
const POLL_MS = 60_000;

/**
 * Where players give up, per court. One step per row: the bar is the share of
 * everyone who scanned, the percentage is the drop from the step above -- the
 * number that says which step leaks.
 */
export function FunnelCard({ courts }: Props) {
  const [days, setDays] = useState<7 | 30>(7);
  const funnel = usePoll(() => superApi.funnel(days), POLL_MS);
  const { refresh } = funnel;
  useEffect(() => {
    void refresh();
  }, [days, refresh]);

  const names = new Map(courts.map((c) => [c.courtId, c.name ?? c.courtId]));
  const all = funnel.data?.courts ?? [];
  const isIdle = (f: CourtFunnel) => f.scans === 0 && f.started === 0 && f.feedback_up + f.feedback_down === 0;
  const active = all.filter((f) => !isIdle(f));
  const idle = all.filter(isIdle);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Player funnel</CardTitle>
          <p className="text-muted-foreground mt-1 text-sm">
            From scanning the sticker to keeping the video. Before Start, one row is one scan;
            after, one match. Staff-started matches and link-preview bots are left out.
          </p>
        </div>
        <div className="flex shrink-0 gap-1" role="group" aria-label="Time range">
          {([7, 30] as const).map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? 'default' : 'outline'}
              onClick={() => setDays(d)}
              aria-pressed={days === d}
            >
              {d} days
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="grid gap-8">
        {funnel.data === undefined ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : funnel.data.courts.length === 0 ? (
          <p className="text-muted-foreground text-sm">No cameras are assigned to a venue.</p>
        ) : (
          <>
            {active.map((f) => (
              <CourtFunnelView key={f.court_id} funnel={f} name={names.get(f.court_id) ?? f.court_id} />
            ))}
            {/* A full table of zeros per idle court buries the one that matters. */}
            {idle.length > 0 && (
              <p className="text-muted-foreground text-sm">
                No scans in the last {days} days: {idle.map((f) => names.get(f.court_id) ?? f.court_id).join(', ')}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface Step {
  label: string;
  value: number;
  /** The step this one is a share of; omitted for the first. */
  of?: number;
  note?: string;
}

const FAIL_LABELS: Record<string, string> = {
  no_consent: 'no consent tick',
  offline: 'camera offline',
  invalid_time: 'bad end time',
  busy: 'court became busy',
  camera: 'camera did not start',
};

function CourtFunnelView({ funnel: f, name }: { funnel: CourtFunnel; name: string }) {
  const failed = Object.entries(f.start_failed)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${FAIL_LABELS[k] ?? k}`)
    .join(', ');
  const sharedBy = Object.entries(f.shared_by)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');

  const steps: Step[] = [
    {
      label: 'Scanned the sticker',
      value: f.scans,
      note: [
        f.scans_busy && `${f.scans_busy} found it busy`,
        f.scans_offline && `${f.scans_offline} found it offline`,
        f.scans_returning && `${f.scans_returning} were starters returning`,
      ]
        .filter(Boolean)
        .join(' · '),
    },
    { label: 'Pressed Start', value: f.start_attempts, of: f.scans_ready, note: failed && `failed: ${failed}` },
    { label: 'Recording started', value: f.started, of: f.start_attempts },
    { label: 'Shared the link', value: f.shared, of: f.started, note: sharedBy && `via ${sharedBy}` },
    { label: 'Link opened by someone else', value: f.opened_by_others, of: f.shared },
    { label: 'Came back when ready', value: f.returned_ready, of: f.started },
    { label: 'Pressed play', value: f.played, of: f.returned_ready },
    { label: 'Watched 30 s+', value: f.watched_30s, of: f.played },
    { label: 'Downloaded', value: f.downloaded, of: f.returned_ready },
  ];
  const max = Math.max(1, ...steps.map((s) => s.value));
  const rated = f.feedback_up + f.feedback_down;

  return (
    <section className="grid gap-3" aria-label={`Funnel for ${name}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">{name}</h3>
        <p className="text-muted-foreground text-xs">
          Stopped by hand {f.stopped_manual} · automatically {f.stopped_auto}
          {f.locked_views > 0 && ` · ${f.locked_views} saw the paywall`}
        </p>
      </div>

      <table className="w-full text-sm">
        <thead className="sr-only">
          <tr>
            <th>Step</th>
            <th>Count</th>
            <th>Of the step before</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const pct = s.of === undefined ? null : s.of > 0 ? Math.round((s.value / s.of) * 100) : null;
            return (
              <tr key={s.label} className="align-top">
                <td className="w-44 py-1 pr-3 sm:w-56">
                  <div>{s.label}</div>
                  {s.note && <div className="text-muted-foreground text-xs">{s.note}</div>}
                </td>
                <td className="py-1">
                  <div className="flex items-center gap-3">
                    <div className="bg-muted relative h-5 flex-1 overflow-hidden rounded-sm">
                      <div
                        className="bg-primary h-full rounded-r-[4px]"
                        style={{ width: `${(s.value / max) * 100}%` }}
                        title={`${s.label}: ${s.value}${pct !== null ? ` (${pct}% of the step before)` : ''}`}
                      />
                    </div>
                    <span className="w-10 text-right font-medium tabular-nums">{s.value}</span>
                    <span className="text-muted-foreground w-12 text-right text-xs tabular-nums">
                      {pct === null ? '' : `${pct}%`}
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="grid gap-2 rounded-lg border p-3">
        <p className="flex items-center gap-4 text-sm">
          <span className="font-medium">Feedback</span>
          <span className="flex items-center gap-1">
            <ThumbsUp className="size-4" aria-hidden /> <span className="sr-only">Useful:</span>
            {f.feedback_up}
          </span>
          <span className="flex items-center gap-1">
            <ThumbsDown className="size-4" aria-hidden /> <span className="sr-only">Not useful:</span>
            {f.feedback_down}
          </span>
          {rated === 0 && <span className="text-muted-foreground text-xs">no answers yet</span>}
        </p>
        {f.comments.length > 0 && (
          <ul className="grid gap-2 text-sm">
            {f.comments.map((c) => (
              <li key={c.created_at} className="flex gap-2">
                {c.rating > 0 ? (
                  <ThumbsUp className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-label="Useful" />
                ) : (
                  <ThumbsDown className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-label="Not useful" />
                )}
                <span className="min-w-0 flex-1 break-words">{c.comment}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{formatDateTime(c.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
