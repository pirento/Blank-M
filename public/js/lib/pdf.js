/**
 * Renders a report element into a paginated A4 PDF. The capture is sliced
 * across real A4 pages instead of one enormous page. jsPDF and html-to-image
 * are loaded as vendor scripts on the Reports page only.
 */

const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const MARGIN_MM = 10;

/**
 * Capture the element as an image, slice it across A4 pages (10 mm margins, theme background)
 * and download the PDF as `fileName`.
 * Throws AbortError when `signal` aborts or `isCurrent()` turns false between steps.
 */
export async function exportElementToPdf(element, fileName, signal, isCurrent) {
  const ensureCurrent = () => {
    signal?.throwIfAborted();
    if (isCurrent && !isCurrent()) throw new DOMException('Report export cancelled.', 'AbortError');
  };
  ensureCurrent();
  const toPng = window.htmlToImage?.toPng;
  const JsPdf = window.jspdf?.jsPDF;
  if (!toPng || !JsPdf)
    throw new Error('PDF export is unavailable. Reload the page and try again.');
  const isDark = document.documentElement.classList.contains('dark');

  const dataUrl = await toPng(element, {
    cacheBust: true,
    backgroundColor: isDark ? '#111111' : '#ffffff',
    pixelRatio: 2,
  });
  ensureCurrent();
  const image = await loadImage(dataUrl);
  ensureCurrent();

  const pdf = new JsPdf({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const contentWidthMm = A4_WIDTH_MM - MARGIN_MM * 2;
  const contentHeightMm = A4_HEIGHT_MM - MARGIN_MM * 2;
  // Scale so the capture fits the printable width, then walk down it one page height at a time.
  const pxPerMm = image.width / contentWidthMm;
  const pageHeightPx = contentHeightMm * pxPerMm;
  const totalPages = Math.max(1, Math.ceil(image.height / pageHeightPx));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a canvas to render the PDF.');

  for (let page = 0; page < totalPages; page++) {
    const sliceTop = page * pageHeightPx;
    const sliceHeight = Math.min(pageHeightPx, image.height - sliceTop);
    canvas.width = image.width;
    canvas.height = sliceHeight;
    context.fillStyle = isDark ? '#111111' : '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, sliceTop, image.width, sliceHeight, 0, 0, image.width, sliceHeight);
    if (page > 0) pdf.addPage();
    pdf.addImage(
      canvas.toDataURL('image/png'),
      'PNG',
      MARGIN_MM,
      MARGIN_MM,
      contentWidthMm,
      sliceHeight / pxPerMm,
    );
  }
  ensureCurrent();
  pdf.save(fileName);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not render the report image.'));
    image.src = dataUrl;
  });
}
