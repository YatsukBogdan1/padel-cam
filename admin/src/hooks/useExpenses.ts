import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { superApi } from '@/api/client';
import type { ExpenseInput } from '@/api/types';
import { usePoll } from './usePoll';

/**
 * Spending changes when someone enters a receipt, not on its own; the poll only
 * keeps two open tabs from disagreeing for long.
 */
const POLL_MS = 60_000;

/**
 * The finance tab's state, shaped like useFleet: a poll, one busy flag that
 * disables every control, and named actions. Each action resolves `true` on
 * success so a form knows whether to clear itself or keep what was typed.
 */
export function useExpenses(onApiError: (error: unknown) => void) {
  const poll = usePoll(superApi.expenses, POLL_MS);
  const [busy, setBusy] = useState(false);
  const { refresh } = poll;

  const run = useCallback(
    async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
      setBusy(true);
      try {
        await action();
        toast.success(success);
        await refresh();
        return true;
      } catch (error) {
        onApiError(error);
        toast.error(error instanceof Error ? error.message : 'Something went wrong');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, onApiError],
  );

  return {
    data: poll.data,
    error: poll.error,
    busy,
    refresh,

    create: (input: ExpenseInput) =>
      run(() => superApi.createExpense(input), `Expense from ${input.vendor} added`),

    update: (id: string, patch: Partial<ExpenseInput>) =>
      run(() => superApi.updateExpense(id, patch), 'Expense updated'),

    remove: (id: string) => run(() => superApi.deleteExpense(id), 'Expense deleted'),
  };
}
