/**
 * Bulk import from a broker CSV or Excel workbook.
 *
 * Nothing is written until the preview has been seen: the page shows exactly
 * what each row will become, including the charges, and marks the rows it
 * believes are duplicates. Each accepted row gets a deterministic ID and a
 * browser checkpoint, so an interrupted import can be retried without copies.
 *
 * The page is split into public/js/pages/import/; this entry listens for a
 * chosen file and paints the first screen.
 */
import { fileInput } from './import/shared.js';
import { readFile } from './import/reading.js';
import { paint } from './import/paint.js';

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void readFile(file);
});

paint();
