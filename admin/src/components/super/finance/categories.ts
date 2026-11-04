import type { ExpenseCategory } from '@/api/types';

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  hardware: 'Hardware',
  cloud: 'Cloud',
  software: 'Software',
  services: 'Services',
  legal: 'Legal',
  other: 'Other',
};

/** A category the server sent that this build does not know still gets a label. */
export function categoryLabel(category: string): string {
  return (CATEGORY_LABELS as Record<string, string | undefined>)[category] ?? category;
}
