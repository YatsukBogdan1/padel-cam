-- Project spending, so the super-admin can see what has been spent so far.
--
-- Company-wide, not per venue: only super-admins read or write it
-- (/api/super/expenses, see src/expenses.ts). Past purchases arrive in bulk from
-- worker/scripts/import-expenses.mjs; later ones are added from the /super UI.
--
-- amount_cents      EUR including VAT, in integer cents so totals never drift
--                   through float rounding. Negative for a refund.
-- currency_original The currency actually paid in, NULL when that was EUR --
-- amount_original_* kept so a USD invoice can be reconciled against the card
--                   statement later. Both NULL, or both set.
-- date              The purchase date as YYYY-MM-DD, not epoch ms: it is a
--                   calendar date off an invoice, with no time or timezone, and
--                   the text form sorts and groups by month directly.
CREATE TABLE IF NOT EXISTS expenses (
  id                    TEXT PRIMARY KEY,
  date                  TEXT NOT NULL,
  vendor                TEXT NOT NULL,
  description           TEXT NOT NULL,
  category              TEXT NOT NULL,
  amount_cents          INTEGER NOT NULL,
  currency_original     TEXT,
  amount_original_cents INTEGER,
  notes                 TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (date);
