// Types for the importer's pure parser, so the workerd test can import it under
// strict TypeScript without turning on allowJs for the whole worker.

export interface ExpenseRow {
  date: string;
  vendor: string;
  description: string;
  category: string;
  amountCents: number;
  currencyOriginal?: string;
  amountOriginalCents?: number;
  notes?: string;
}

export const HEADER: string[];
export function parseCsv(text: string): string[][];
export function decimalToCents(value: string): number;
export function parseExpensesCsv(text: string): ExpenseRow[];
export function formatEur(cents: number): string;
