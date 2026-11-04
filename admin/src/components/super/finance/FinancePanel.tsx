import { useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/api/client';
import { EXPENSE_CATEGORIES, type Expense, type ExpensesResponse } from '@/api/types';
import { useExpenses } from '@/hooks/useExpenses';
import { formatDay, formatEuros, formatMonth, formatOriginal } from '@/lib/money';
import { categoryLabel } from './categories';
import { ExpenseForm, changedFields } from './ExpenseForm';

interface Props {
  onApiError: (error: unknown) => void;
}

/**
 * What the company has spent so far. Totals come from the server, so they are
 * the same numbers whoever looks and however the table below is filtered.
 */
export function FinancePanel({ onApiError }: Props) {
  const expenses = useExpenses(onApiError);
  const [editing, setEditing] = useState<Expense>();

  if (expenses.data === undefined) {
    if (expenses.error) {
      // 404 is what /api/super answers to anything it does not serve -- either
      // the account lost the flag, or this Worker predates the expenses API.
      const missing = expenses.error instanceof ApiError && expenses.error.status === 404;
      return (
        <Alert variant="destructive">
          <AlertTitle>Could not load expenses</AlertTitle>
          <AlertDescription className="grid gap-3">
            <p>
              {missing
                ? 'The expenses API is not available on this server.'
                : expenses.error.message}
            </p>
            <div>
              <Button variant="outline" size="sm" onClick={() => void expenses.refresh()}>
                Try again
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <div className="grid gap-4" aria-busy="true" aria-label="Loading expenses">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="grid gap-8">
      {expenses.error && (
        <p className="text-muted-foreground text-xs" role="status">
          Could not refresh ({expenses.error.message}); showing the last loaded figures.
        </p>
      )}

      <SummaryCard data={expenses.data} />

      <Card>
        <CardHeader>
          <CardTitle>Add expense</CardTitle>
          <p className="text-muted-foreground text-sm">
            The euro amount actually paid, including VAT. Enter a refund as a negative amount.
          </p>
        </CardHeader>
        <CardContent>
          <ExpenseForm busy={expenses.busy} submitLabel="Add expense" onSubmit={expenses.create} />
        </CardContent>
      </Card>

      <ExpensesCard
        expenses={expenses.data.expenses}
        busy={expenses.busy}
        onEdit={setEditing}
        onDelete={expenses.remove}
      />

      <Dialog open={editing !== undefined} onOpenChange={(open) => !open && setEditing(undefined)}>
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit expense</DialogTitle>
            <DialogDescription>
              {editing ? `${editing.vendor} · ${formatDay(editing.date)}` : null}
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <ExpenseForm
              key={editing.id}
              initial={editing}
              busy={expenses.busy}
              submitLabel="Save changes"
              onCancel={() => setEditing(undefined)}
              onSubmit={async (input) => {
                const patch = changedFields(editing, input);
                if (Object.keys(patch).length === 0) {
                  setEditing(undefined);
                  return true;
                }
                const saved = await expenses.update(editing.id, patch);
                if (saved) setEditing(undefined);
                return saved;
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryCard({ data }: { data: ExpensesResponse }) {
  const { totals } = data;
  const categories = Object.entries(totals.byCategory)
    .filter(([, cents]) => cents !== 0)
    .sort(([, a], [, b]) => b - a);
  // Oldest first reads like a timeline; a gap month is simply absent.
  const months = Object.entries(totals.byMonth).sort(([a], [b]) => a.localeCompare(b));

  return (
    <Card>
      <CardHeader>
        <p className="text-muted-foreground text-sm">Total spent so far</p>
        <p className="text-4xl font-semibold tracking-tight tabular-nums">
          {formatEuros(totals.allCents)}
        </p>
        <p className="text-muted-foreground text-xs">
          EUR incl. VAT, across {data.expenses.length}{' '}
          {data.expenses.length === 1 ? 'expense' : 'expenses'}
        </p>
      </CardHeader>
      <CardContent className="grid gap-8 md:grid-cols-2">
        <BarList title="By category" rows={categories.map(([k, v]) => [categoryLabel(k), v])} />
        <BarList title="By month" rows={months.map(([k, v]) => [formatMonth(k), v])} />
      </CardContent>
    </Card>
  );
}

/**
 * A row per bucket with a bar scaled to the largest. No chart library: this is
 * a handful of rows, and the number beside each bar is what gets read.
 */
function BarList({ title, rows }: { title: string; rows: Array<[string, number]> }) {
  const max = Math.max(1, ...rows.map(([, v]) => Math.abs(v)));
  return (
    <section className="grid content-start gap-2" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing yet.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([label, cents]) => (
              <tr key={label}>
                <td className="w-24 py-1 pr-3 whitespace-nowrap">{label}</td>
                <td className="py-1">
                  <div className="bg-muted h-4 overflow-hidden rounded-sm">
                    <div
                      className={`h-full rounded-r-[4px] ${cents < 0 ? 'bg-destructive/60' : 'bg-primary'}`}
                      style={{ width: `${(Math.abs(cents) / max) * 100}%` }}
                    />
                  </div>
                </td>
                <td className="py-1 pl-3 text-right font-medium whitespace-nowrap tabular-nums">
                  {formatEuros(cents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface ExpensesCardProps {
  expenses: Expense[];
  busy: boolean;
  onEdit: (expense: Expense) => void;
  onDelete: (id: string) => Promise<boolean>;
}

function ExpensesCard({ expenses, busy, onEdit, onDelete }: ExpensesCardProps) {
  const [category, setCategory] = useState('');
  const [newestFirst, setNewestFirst] = useState(true);
  const [confirming, setConfirming] = useState<string>();

  const shown = expenses
    .filter((e) => category === '' || e.category === category)
    .sort((a, b) => {
      // Same day: order of entry, so a sort toggle never shuffles a day's rows.
      const cmp = a.date.localeCompare(b.date) || a.created_at - b.created_at;
      return newestFirst ? -cmp : cmp;
    });
  const shownTotal = shown.reduce((sum, e) => sum + e.amount_cents, 0);

  const remove = async (id: string) => {
    if (await onDelete(id)) setConfirming(undefined);
  };

  const original = (e: Expense) =>
    e.currency_original && e.amount_original_cents !== null
      ? formatOriginal(e.amount_original_cents, e.currency_original)
      : null;

  const SortIcon = newestFirst ? ArrowDown : ArrowUp;

  const actions = (e: Expense, phone: boolean) =>
    confirming === e.id ? (
      <div className="flex flex-wrap items-center justify-end gap-2" role="group" aria-label="Confirm delete">
        <span className="text-destructive text-xs">Delete for good?</span>
        <Button
          variant="outline"
          size={phone ? 'default' : 'sm'}
          className={phone ? 'h-10' : undefined}
          disabled={busy}
          onClick={() => setConfirming(undefined)}
        >
          Keep
        </Button>
        <Button
          variant="destructive"
          size={phone ? 'default' : 'sm'}
          className={phone ? 'h-10' : undefined}
          disabled={busy}
          onClick={() => void remove(e.id)}
        >
          Delete
        </Button>
      </div>
    ) : (
      <div className="flex justify-end gap-1">
        <Button
          variant="ghost"
          className={phone ? 'h-10 px-2' : undefined}
          size={phone ? 'default' : 'icon-sm'}
          disabled={busy}
          aria-label={`Edit ${e.vendor} ${formatDay(e.date)}`}
          onClick={() => onEdit(e)}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          className={phone ? 'h-10 px-2' : undefined}
          size={phone ? 'default' : 'icon-sm'}
          disabled={busy}
          aria-label={`Delete ${e.vendor} ${formatDay(e.date)}`}
          onClick={() => setConfirming(e.id)}
        >
          <Trash2 />
        </Button>
      </div>
    );

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <CardTitle>Expenses</CardTitle>
          <p className="text-muted-foreground mt-1 text-sm">
            {category === ''
              ? `${shown.length} in total`
              : `${shown.length} in ${categoryLabel(category)} · ${formatEuros(shownTotal)}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="border-input bg-background h-10 rounded-md border px-2 text-sm sm:h-8"
            aria-label="Filter by category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">All categories</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            className="h-10 sm:h-8"
            onClick={() => setNewestFirst((v) => !v)}
            aria-label={newestFirst ? 'Sorted newest first; sort oldest first' : 'Sorted oldest first; sort newest first'}
          >
            <SortIcon />
            {newestFirst ? 'Newest first' : 'Oldest first'}
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {shown.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {expenses.length === 0 ? 'No expenses recorded yet.' : 'No expenses in this category.'}
          </p>
        ) : (
          <>
            {/* Phones: cards. Seven columns do not fit 390px. */}
            <ul className="grid gap-2 md:hidden">
              {shown.map((e) => (
                <li key={e.id} className="grid gap-2 rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{e.vendor}</p>
                      <p className="text-muted-foreground text-xs">
                        {formatDay(e.date)} · {categoryLabel(e.category)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={`font-medium tabular-nums ${e.amount_cents < 0 ? 'text-destructive' : ''}`}>
                        {formatEuros(e.amount_cents)}
                      </p>
                      {original(e) && (
                        <p className="text-muted-foreground text-xs tabular-nums">{original(e)}</p>
                      )}
                    </div>
                  </div>
                  <p className="text-sm break-words">{e.description}</p>
                  {e.notes && (
                    <p className="text-muted-foreground text-xs break-words">{e.notes}</p>
                  )}
                  {actions(e, true)}
                </li>
              ))}
            </ul>

            <div className="hidden overflow-x-auto rounded-lg border md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((e) => (
                    <TableRow key={e.id} className="align-top">
                      <TableCell className="whitespace-nowrap">{formatDay(e.date)}</TableCell>
                      <TableCell className="font-medium">{e.vendor}</TableCell>
                      <TableCell className="max-w-56 whitespace-normal break-words">
                        {e.description}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{categoryLabel(e.category)}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className={e.amount_cents < 0 ? 'text-destructive' : undefined}>
                          {formatEuros(e.amount_cents)}
                        </span>
                        {original(e) && (
                          <div className="text-muted-foreground text-xs">{original(e)}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-48 text-xs whitespace-normal break-words">
                        {e.notes}
                      </TableCell>
                      <TableCell className="text-right">{actions(e, false)}</TableCell>
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
