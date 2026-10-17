/**
 * Phone layout for wide tables: a table with class `stack-table` shows each
 * row as a card on narrow screens (see .stack-table in assets/css/app.css).
 * Each cell gets its column heading as `data-label`, which the CSS prints
 * beside the value. Tables are re-labelled whenever pages re-render them.
 */
function label(table) {
  const headings = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  for (const row of table.querySelectorAll('tbody tr')) {
    [...row.children].forEach((cell, index) => {
      const heading = headings[index];
      if (heading && cell.dataset.label !== heading) cell.dataset.label = heading;
    });
  }
}

/** Label every `table.stack-table` under root now, then again (once per frame) after any DOM change. */
export function watchStackTables(root = document.body) {
  let queued = false;
  const run = () => {
    queued = false;
    for (const table of root.querySelectorAll('table.stack-table')) label(table);
  };
  run();
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  }).observe(root, { childList: true, subtree: true });
}
