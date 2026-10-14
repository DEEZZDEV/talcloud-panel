import type { Cost, CostCategory, CostInput, CostRecurrence } from '@shared/api-types';
import { db } from '../../db/index.js';

interface CostRow {
  id: number;
  label: string;
  category: string;
  amount: number;
  recurrence: string;
  start_month: string;
  end_month: string | null;
  notes: string | null;
  created_at: number;
}

const COLUMNS = 'id, label, category, amount, recurrence, start_month, end_month, notes, created_at';

const toCost = (row: CostRow): Cost => ({
  id: row.id,
  label: row.label,
  category: row.category as CostCategory,
  amount: row.amount,
  recurrence: row.recurrence as CostRecurrence,
  startMonth: row.start_month,
  endMonth: row.end_month,
  notes: row.notes,
  createdAt: new Date(row.created_at).toISOString(),
});

export function listCosts(): Cost[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM costs ORDER BY start_month DESC, id DESC`).all() as CostRow[];
  return rows.map(toCost);
}

export function getCost(id: number): Cost | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM costs WHERE id = ?`).get(id) as CostRow | undefined;
  return row ? toCost(row) : null;
}

export function createCost(input: CostInput): Cost {
  const result = db
    .prepare('INSERT INTO costs (label, category, amount, recurrence, start_month, end_month, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(input.label, input.category, input.amount, input.recurrence, input.startMonth, input.endMonth, input.notes, Date.now());
  return getCost(Number(result.lastInsertRowid))!;
}

export function updateCost(id: number, input: CostInput): Cost | null {
  const result = db
    .prepare('UPDATE costs SET label = ?, category = ?, amount = ?, recurrence = ?, start_month = ?, end_month = ?, notes = ? WHERE id = ?')
    .run(input.label, input.category, input.amount, input.recurrence, input.startMonth, input.endMonth, input.notes, id);
  return result.changes ? getCost(id) : null;
}

export function deleteCost(id: number): boolean {
  return db.prepare('DELETE FROM costs WHERE id = ?').run(id).changes > 0;
}

/**
 * Part d'un coût imputée à un mois (« YYYY-MM », comparables comme des chaînes) :
 *  - monthly  : le montant, chaque mois de startMonth à endMonth inclus (sans fin si endMonth est null) ;
 *  - yearly   : 1/12 du montant, chaque mois de la même période (lissage, pas d'imputation à la date de paiement) ;
 *  - one_time : le montant, uniquement sur startMonth.
 */
export function costForMonth(cost: Pick<Cost, 'amount' | 'recurrence' | 'startMonth' | 'endMonth'>, month: string): number {
  if (cost.recurrence === 'one_time') return month === cost.startMonth ? cost.amount : 0;
  if (month < cost.startMonth) return 0;
  if (cost.endMonth !== null && month > cost.endMonth) return 0;
  return cost.recurrence === 'yearly' ? cost.amount / 12 : cost.amount;
}

/** Total non arrondi des coûts saisis, par mois. */
export function costsByMonth(months: readonly string[], costs: readonly Cost[] = listCosts()): Map<string, number> {
  return new Map(months.map((month) => [month, costs.reduce((sum, cost) => sum + costForMonth(cost, month), 0)]));
}
