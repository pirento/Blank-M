/**
 * Trade book CSV export (safe for spreadsheets).
 */
import { csvTextCell } from './csv.js';

/**
 * The trade-book CSV export. Text cells are formula-neutralized; numeric cells
 * stay typed so negative and zero P&L remain numbers in a spreadsheet.
 */
export function buildTradesCsv(trades) {
  const header = [
    'Date',
    'Symbol',
    'Direction',
    'Quantity',
    'Entry',
    'Exit',
    'Gross P&L',
    'Charges',
    'Net P&L',
    'Notes',
    // Named so the import page never mistakes them for the price columns.
    'Stop-loss',
    'Entered at',
    'Exited at',
    // Contract details, so a re-imported F&O trade keeps its segment (shared/csv.js reads them).
    'Segment',
    'Strike',
    'Option type',
    'Expiry',
    'Lot size',
  ];
  const rows = trades.map((trade) => [
    csvTextCell(trade.date),
    csvTextCell(trade.symbol),
    csvTextCell(trade.type),
    trade.quantity,
    trade.entryPrice,
    trade.exitPrice,
    trade.grossPnl,
    trade.charges,
    trade.pnl,
    csvTextCell(trade.notes),
    trade.stopLoss ?? '',
    csvTextCell(trade.entryTime ?? ''),
    csvTextCell(trade.exitTime ?? ''),
    csvTextCell(trade.segment ?? 'EQ'),
    trade.strike ?? '',
    csvTextCell(trade.optionType ?? ''),
    csvTextCell(trade.expiry ?? ''),
    trade.lotSize ?? '',
  ]);
  return [header, ...rows].map((row) => row.join(',')).join('\n');
}
