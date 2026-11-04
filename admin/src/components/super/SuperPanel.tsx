import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useFleet } from '@/hooks/useFleet';
import { AllRecordingsCard } from './AllRecordingsCard';
import { CleanupCard } from './CleanupCard';
import { FleetCourts } from './FleetCourts';
import { FreePeriodCard } from './FreePeriodCard';
import { FunnelCard } from './FunnelCard';
import { VenuesCard } from './VenuesCard';
import { FinancePanel } from './finance/FinancePanel';

export type SuperTab = 'fleet' | 'finance';

/** Each tab is a real path, so a reload or a bookmark lands on the same tab. */
export const SUPER_TAB_PATHS: Record<SuperTab, string> = {
  fleet: '/super',
  finance: '/super/finance',
};

const TAB_LABELS: Record<SuperTab, string> = { fleet: 'Fleet', finance: 'Finance' };

interface Props {
  email: string;
  tab: SuperTab;
  onApiError: (error: unknown) => void;
  onNavigate: (path: string) => void;
  onLeave: () => void;
}

/**
 * The fleet-wide operator page, mounted only at /super and only for an account
 * carrying is_superadmin. Hiding it in the UI is a convenience; the actual
 * boundary is that every /api/super route answers 404 without the flag.
 */
export function SuperPanel({ email, tab, onApiError, onNavigate, onLeave }: Props) {
  return (
    <div className="mx-auto grid max-w-5xl gap-8 p-4 sm:p-6 md:p-10">
      <header className="grid gap-4 border-b pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Fleet administration</h1>
            <p className="text-muted-foreground truncate text-sm">{email}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onLeave}>
            <ArrowLeft />
            Venue dashboard
          </Button>
        </div>
        <nav className="flex gap-1" aria-label="Super-admin sections">
          {(Object.keys(SUPER_TAB_PATHS) as SuperTab[]).map((t) => (
            <Button
              key={t}
              asChild
              variant={tab === t ? 'secondary' : 'ghost'}
              className="h-10 px-4 sm:h-8"
            >
              <a
                href={SUPER_TAB_PATHS[t]}
                aria-current={tab === t ? 'page' : undefined}
                onClick={(e) => {
                  // Plain clicks stay in the SPA; modified clicks open a tab as usual.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  onNavigate(SUPER_TAB_PATHS[t]);
                }}
              >
                {TAB_LABELS[t]}
              </a>
            </Button>
          ))}
        </nav>
      </header>

      {tab === 'finance' ? (
        <FinancePanel onApiError={onApiError} />
      ) : (
        <FleetView onApiError={onApiError} />
      )}
    </div>
  );
}

/** Split out so the fleet poll runs only while its tab is open. */
function FleetView({ onApiError }: { onApiError: (error: unknown) => void }) {
  const fleet = useFleet(onApiError);

  return (
    <>
      {fleet.data === undefined ? (
        <div className="grid gap-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <>
          <section className="grid gap-4">
            <div>
              <h2 className="text-lg font-medium">Cameras</h2>
              <p className="text-muted-foreground text-sm">
                A camera registers itself the first time it connects and belongs to
                nobody until assigned here. Unassigned cameras are invisible to every
                club.
              </p>
            </div>
            <FleetCourts
              courts={fleet.data.courts}
              venues={fleet.data.venues}
              busy={fleet.busy}
              onAssign={fleet.assignCourt}
              onDelete={fleet.deleteCourt}
            />
          </section>

          <FunnelCard courts={fleet.data.courts} />

          <FreePeriodCard
            courts={fleet.data.courts}
            engagement={fleet.data.engagement}
            busy={fleet.busy}
            onSetFreeUntil={fleet.setFreeUntil}
          />

          <CleanupCard
            active={fleet.data.active}
            busy={fleet.busy}
            onCleanup={fleet.cleanup}
            onPurge={fleet.purgeRecording}
          />

          <AllRecordingsCard
            recordings={fleet.data.recordings}
            busy={fleet.busy}
            onPurge={fleet.purgeRecordings}
          />

          <VenuesCard
            venues={fleet.data.venues}
            busy={fleet.busy}
            onCreate={fleet.createVenue}
            onSetSchedule={fleet.setVenueSchedule}
          />
        </>
      )}
    </>
  );
}
