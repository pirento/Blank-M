/** Keep decimal strings intact; spreadsheet date cells represent calendar dates. */
export function normalizeSheet(name, data) {
  if (data.length > 20001 || data.some((row) => row.length > 200))
    throw new Error('Split the workbook into sheets with at most 20,000 trades and 200 columns.');
  const cells = data
    .map((row) =>
      row.map((cell) => {
        if (cell == null) return '';
        if (cell instanceof Date) {
          if (!Number.isFinite(cell.getTime()))
            throw new Error('The workbook contains an invalid date.');
          return cell.toISOString().slice(0, 10);
        }
        if (typeof cell === 'string' || typeof cell === 'boolean') return String(cell);
        if (typeof cell === 'number' && Number.isFinite(cell)) return String(cell);
        throw new Error('The workbook contains an unsupported cell value.');
      }),
    )
    .filter((row) => row.some((cell) => cell.trim() !== ''));
  const [headers = [], ...rows] = cells;
  return { name, headers: headers.map((cell) => cell.trim()), rows };
}
