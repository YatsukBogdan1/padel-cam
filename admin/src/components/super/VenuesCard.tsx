import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { FleetVenue } from '@/api/types';

interface Props {
  venues: FleetVenue[];
  busy: boolean;
  onCreate: (id: string, name: string) => void;
  onSetSchedule: (venueId: string, timezone: string, slotMinutes: number) => void;
}

const SLOT_CHOICES = [15, 20, 30, 60];

/**
 * Venues exist before their admin accounts do — worker/scripts/create-admin.mjs
 * creates both, but a venue you want to assign cameras to ahead of onboarding
 * its staff can be made here.
 */
export function VenuesCard({ venues, busy, onCreate, onSetSchedule }: Props) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !name.trim()) return;
    onCreate(id.trim().toLowerCase(), name.trim());
    setId('');
    setName('');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Venues</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {venues.length > 0 && (
          <ul className="grid gap-3 text-sm">
            {venues.map((venue) => (
              <VenueRow key={venue.id} venue={venue} busy={busy} onSave={onSetSchedule} />
            ))}
          </ul>
        )}

        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor="venue-id">Slug</Label>
            <Input
              id="venue-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="my-club"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="venue-name">Name</Label>
            <Input
              id="venue-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Club"
            />
          </div>
          <Button type="submit" disabled={busy || !id.trim() || !name.trim()}>
            Add venue
          </Button>
        </form>

        <p className="text-muted-foreground text-xs">
          Creating a venue here does not create its admin account. Run{' '}
          <code className="font-mono">worker/scripts/create-admin.mjs</code> for that.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The booking grid players are offered end times on. A wrong timezone shows them
 * the wrong clock at the court, so it is set here rather than assumed.
 */
function VenueRow({
  venue,
  busy,
  onSave,
}: {
  venue: FleetVenue;
  busy: boolean;
  onSave: (venueId: string, timezone: string, slotMinutes: number) => void;
}) {
  const [timezone, setTimezone] = useState(venue.timezone);
  const [slot, setSlot] = useState(venue.slot_minutes);
  const dirty = timezone !== venue.timezone || slot !== venue.slot_minutes;

  return (
    <li className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <span>{venue.name}</span>
        <span className="text-muted-foreground ml-2 font-mono text-xs">{venue.id}</span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          className="h-8 w-40"
          value={timezone}
          disabled={busy}
          onChange={(e) => setTimezone(e.target.value)}
          aria-label={`Timezone for ${venue.name}`}
        />
        <select
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
          value={slot}
          disabled={busy}
          onChange={(e) => setSlot(Number(e.target.value))}
          aria-label={`Booking slot length for ${venue.name}`}
        >
          {SLOT_CHOICES.map((m) => (
            <option key={m} value={m}>
              {m} min slots
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !dirty}
          onClick={() => onSave(venue.id, timezone.trim(), slot)}
        >
          Save
        </Button>
      </div>
    </li>
  );
}
