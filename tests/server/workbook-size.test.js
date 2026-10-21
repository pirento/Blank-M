// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assertWorkbookSize } from '../../controllers/uploads.controller.js';

/** A zip holding only a central directory whose entries declare `sizes` unpacked bytes. */
function zipDeclaring(sizes) {
  const entries = sizes.map((size, index) => {
    const name = Buffer.from(`xl/sheet${index}.xml`);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    return Buffer.concat([header, name]);
  });
  const directory = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sizes.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(0, 16);
  return Buffer.concat([directory, end]);
}

describe('workbook size check', () => {
  it('accepts normal workbooks and refuses ones that would unpack to gigabytes', () => {
    expect(() => assertWorkbookSize(zipDeclaring([2_000, 50_000]))).not.toThrow();
    expect(() => assertWorkbookSize(zipDeclaring([4_000_000_000]))).toThrow(/too large/);
    expect(() => assertWorkbookSize(zipDeclaring(Array(30).fill(5_000_000)))).toThrow(/too large/);
    // Not a zip at all: left to the reader, which rejects it.
    expect(() => assertWorkbookSize(Buffer.from('not a workbook'))).not.toThrow();
  });
});
