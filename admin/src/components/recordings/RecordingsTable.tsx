import { Download, QrCode } from 'lucide-react';
import { StatusBadge } from '@/components/common/StatusBadge';
import { Thumbnail } from '@/components/common/Thumbnail';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/api/client';
import type { Recording } from '@/api/types';
import { formatBytes, formatDateTime, formatDuration } from '@/lib/format';

interface Props {
  recordings: Recording[];
  busy: boolean;
  onShare: (recordingId: string) => void;
}

export function RecordingsTable({ recordings, busy, onShare }: Props) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Frame</TableHead>
            <TableHead>Court</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Length</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Share</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recordings.map((rec) => (
            <TableRow key={rec.id}>
              <TableCell>
                <Thumbnail recordingId={rec.id} thumbnailKey={rec.thumbnail_key} />
              </TableCell>
              <TableCell className="font-medium">{rec.court_id}</TableCell>
              <TableCell>{formatDateTime(rec.started_at)}</TableCell>
              <TableCell className="tabular-nums">
                {formatDuration(rec.started_at, rec.stopped_at)}
              </TableCell>
              <TableCell className="tabular-nums">{formatBytes(rec.bytes)}</TableCell>
              <TableCell>
                <StatusBadge status={rec.status} reason={rec.error} />
                {rec.status === 'failed' && rec.error && (
                  <p className="text-muted-foreground mt-1 max-w-xs truncate text-xs">
                    {rec.error}
                  </p>
                )}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  {/*
                    Two separate buttons rather than one with a conditional
                    child: the Button lays its children out with flex, so the
                    icon and label must be its DIRECT children. Wrapping them in
                    a <span> for the disabled case made that span the only flex
                    item, and Tailwind's preflight sets `svg { display: block }`,
                    which stacked the icon above the label.
                  */}
                  {rec.status === 'ready' ? (
                    <Button variant="outline" size="sm" asChild>
                      <a href={api.downloadUrl(rec.id)} download>
                        <Download />
                        Download
                      </a>
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled>
                      <Download />
                      Download
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={busy || rec.status !== 'ready'}
                    onClick={() => onShare(rec.id)}
                  >
                    <QrCode />
                    QR code
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
