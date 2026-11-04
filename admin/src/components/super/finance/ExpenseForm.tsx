import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EXPENSE_CATEGORIES, type Expense, type ExpenseCategory, type ExpenseInput } from '@/api/types';
import { centsToInput, parseAmount, todayInput } from '@/lib/money';
import { CATEGORY_LABELS } from './categories';

interface Props {
  /** Absent: a new expense. Present: the row being edited. */
  initial?: Expense;
  busy: boolean;
  submitLabel: string;
  /** Resolves true on success; the form only clears itself then. */
  onSubmit: (input: ExpenseInput) => Promise<boolean>;
  onCancel?: () => void;
}

interface Draft {
  date: string;
  vendor: string;
  description: string;
  category: ExpenseCategory;
  amount: string;
  currencyOriginal: string;
  amountOriginal: string;
  notes: string;
}

function isCategory(value: string): value is ExpenseCategory {
  return (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

function draftFrom(expense?: Expense): Draft {
  if (!expense) {
    return {
      date: todayInput(),
      vendor: '',
      description: '',
      category: 'hardware',
      amount: '',
      currencyOriginal: '',
      amountOriginal: '',
      notes: '',
    };
  }
  return {
    date: expense.date,
    vendor: expense.vendor,
    description: expense.description,
    category: isCategory(expense.category) ? expense.category : 'other',
    amount: centsToInput(expense.amount_cents),
    currencyOriginal: expense.currency_original ?? '',
    amountOriginal:
      expense.amount_original_cents === null ? '' : centsToInput(expense.amount_original_cents),
    notes: expense.notes ?? '',
  };
}

type Checked = { ok: true; input: ExpenseInput } | { ok: false; errors: Partial<Record<keyof Draft, string>> };

function check(d: Draft): Checked {
  const errors: Partial<Record<keyof Draft, string>> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) errors.date = 'Pick a date';
  if (!d.vendor.trim()) errors.vendor = 'Who was paid?';
  if (!d.description.trim()) errors.description = 'What was it for?';

  const amount = parseAmount(d.amount);
  if (!amount.ok) errors.amount = amount.error;
  else if (amount.cents === 0) errors.amount = 'Amount cannot be zero';

  // The original currency is a pair: a code without an amount (or the reverse)
  // records half a fact, so it is both or neither.
  const currency = d.currencyOriginal.trim().toUpperCase();
  const hasOriginal = currency !== '' || d.amountOriginal.trim() !== '';
  let originalCents: number | null = null;
  if (hasOriginal) {
    if (!/^[A-Z]{3}$/.test(currency)) errors.currencyOriginal = 'Three-letter code, e.g. USD';
    const original = parseAmount(d.amountOriginal);
    if (!original.ok) errors.amountOriginal = original.error;
    else originalCents = original.cents;
  }

  if (Object.keys(errors).length > 0 || !amount.ok) return { ok: false, errors };
  return {
    ok: true,
    input: {
      date: d.date,
      vendor: d.vendor.trim(),
      description: d.description.trim(),
      category: d.category,
      amountCents: amount.cents,
      currencyOriginal: hasOriginal ? currency : null,
      amountOriginalCents: hasOriginal ? originalCents : null,
      notes: d.notes.trim() || null,
    },
  };
}

/**
 * Add and edit share one form, so the two can never disagree about what a
 * valid expense is. The amount is the euro figure on the invoice including VAT;
 * the original-currency pair is only for a purchase made in something else.
 */
export function ExpenseForm({ initial, busy, submitLabel, onSubmit, onCancel }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial));
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const prefix = initial ? `edit-${initial.id}` : 'new-expense';

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = check(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    const saved = await onSubmit(result.input);
    // Clear only a new-expense form: a failed save keeps what was typed, and an
    // edit form is closed by its parent.
    if (saved && !initial) setDraft({ ...draftFrom(), date: draft.date, category: draft.category });
  };

  const field = (key: keyof Draft, label: string, input: React.ReactNode, className = '') => (
    <div className={`grid content-start gap-1.5 ${className}`}>
      <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
      {input}
      {errors[key] && (
        <p id={`${prefix}-${key}-error`} className="text-destructive text-xs">
          {errors[key]}
        </p>
      )}
    </div>
  );

  const aria = (key: keyof Draft) => ({
    id: `${prefix}-${key}`,
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': errors[key] ? `${prefix}-${key}-error` : undefined,
  });

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-6" noValidate>
      {field(
        'date',
        'Date',
        <Input
          {...aria('date')}
          type="date"
          className="h-10 sm:h-8"
          value={draft.date}
          disabled={busy}
          onChange={(e) => set('date', e.target.value)}
        />,
        'sm:col-span-2',
      )}
      {field(
        'category',
        'Category',
        <select
          {...aria('category')}
          className="border-input bg-background h-10 rounded-md border px-2 text-sm sm:h-8"
          value={draft.category}
          disabled={busy}
          onChange={(e) => {
            if (isCategory(e.target.value)) set('category', e.target.value);
          }}
        >
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>,
        'sm:col-span-2',
      )}
      {field(
        'amount',
        'Amount (€, incl. VAT)',
        <Input
          {...aria('amount')}
          inputMode="decimal"
          autoComplete="off"
          className="h-10 tabular-nums sm:h-8"
          placeholder="149.90"
          value={draft.amount}
          disabled={busy}
          onChange={(e) => set('amount', e.target.value)}
        />,
        'sm:col-span-2',
      )}
      {field(
        'vendor',
        'Vendor',
        <Input
          {...aria('vendor')}
          className="h-10 sm:h-8"
          placeholder="PiHut"
          value={draft.vendor}
          disabled={busy}
          onChange={(e) => set('vendor', e.target.value)}
        />,
        'sm:col-span-2',
      )}
      {field(
        'description',
        'Description',
        <Input
          {...aria('description')}
          className="h-10 sm:h-8"
          placeholder="Raspberry Pi 5 8GB"
          value={draft.description}
          disabled={busy}
          onChange={(e) => set('description', e.target.value)}
        />,
        'sm:col-span-4',
      )}
      {field(
        'currencyOriginal',
        'Original currency',
        <Input
          {...aria('currencyOriginal')}
          className="h-10 uppercase sm:h-8"
          placeholder="optional, e.g. USD"
          maxLength={3}
          autoComplete="off"
          value={draft.currencyOriginal}
          disabled={busy}
          onChange={(e) => set('currencyOriginal', e.target.value)}
        />,
        'sm:col-span-2',
      )}
      {field(
        'amountOriginal',
        'Original amount',
        <Input
          {...aria('amountOriginal')}
          inputMode="decimal"
          autoComplete="off"
          className="h-10 tabular-nums sm:h-8"
          placeholder="optional"
          value={draft.amountOriginal}
          disabled={busy}
          onChange={(e) => set('amountOriginal', e.target.value)}
        />,
        'sm:col-span-2',
      )}
      {field(
        'notes',
        'Notes',
        <Input
          {...aria('notes')}
          className="h-10 sm:h-8"
          placeholder="optional"
          value={draft.notes}
          disabled={busy}
          onChange={(e) => set('notes', e.target.value)}
        />,
        'sm:col-span-2',
      )}

      <div className="flex flex-wrap justify-end gap-2 sm:col-span-6">
        {onCancel && (
          <Button type="button" variant="outline" className="h-10 sm:h-8" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" className="h-10 sm:h-8" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * Only the fields that changed, so an edit never rewrites a column it did not
 * touch (and two people editing different fields do not undo each other).
 */
export function changedFields(before: Expense, after: ExpenseInput): Partial<ExpenseInput> {
  const patch: Partial<ExpenseInput> = {};
  if (after.date !== before.date) patch.date = after.date;
  if (after.vendor !== before.vendor) patch.vendor = after.vendor;
  if (after.description !== before.description) patch.description = after.description;
  if (after.category !== before.category) patch.category = after.category;
  if (after.amountCents !== before.amount_cents) patch.amountCents = after.amountCents;
  if ((after.currencyOriginal ?? null) !== before.currency_original)
    patch.currencyOriginal = after.currencyOriginal ?? null;
  if ((after.amountOriginalCents ?? null) !== before.amount_original_cents)
    patch.amountOriginalCents = after.amountOriginalCents ?? null;
  if ((after.notes ?? null) !== before.notes) patch.notes = after.notes ?? null;
  return patch;
}
