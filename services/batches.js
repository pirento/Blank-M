/**
 * Runs `work(item)` for every item, at most `size` at a time (quote reads in the scheduled price
 * checks, so thousands of alerts finish within the 5-minute schedule without flooding a provider).
 */
export async function inBatches(items, size, work) {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(work));
  }
}
