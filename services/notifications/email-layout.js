/**
 * The branded HTML version of every email, built from its plain text so both parts always say the
 * same thing. In the text: blank lines separate paragraphs, "- " starts a list item, and a line
 * that is only a link to this site ("https://…" or "Label: https://…") becomes a button. Links
 * elsewhere stay plain text, so text a visitor typed can never become a button or a link. The
 * footer carries the business details from the admin panel and links to the legal pages.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
const LINK_LINE = /^(?:([^:]{1,60}):\s+)?(https?:\/\/\S+)$/;
const INLINE_LINK = /https?:\/\/[^\s<]+/g;

const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TEXT = `margin:0 0 16px;font-size:15px;line-height:1.6;color:#2a363b;${FONT}`;
const ACCENT = '#446e47';

/** This site's origin from APP_URL, or '' when it is unset or not a valid URL. */
export const siteOrigin = () => {
  try {
    return new URL(process.env.APP_URL || '').origin;
  } catch {
    return '';
  }
};

function button(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="border-radius:8px;background:${ACCENT}"><a href="${escape(href)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;${FONT}">${escape(label)}</a></td></tr></table>`;
}

/** Quotes text someone typed (each line starts with "> "), so it reads as their words. */
export const quote = (text) =>
  String(text)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');

/** Only links to this site (APP_URL) are clickable. */
const ours = (url) => Boolean(siteOrigin()) && url.startsWith(`${siteOrigin()}/`);

const linkify = (escaped) =>
  escaped.replace(INLINE_LINK, (url) =>
    ours(url) ? `<a href="${url}" style="color:${ACCENT};word-break:break-all">${url}</a>` : url,
  );

function renderBlock(block) {
  const out = [];
  let paragraph = [];
  let list = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p style="${TEXT}">${paragraph.join('<br>')}</p>`);
    if (list.length) {
      out.push(`<ul style="${TEXT};padding-left:20px">${list.join('')}</ul>`);
    }
    paragraph = [];
    list = [];
  };
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    const link = LINK_LINE.exec(line);
    if (link && ours(link[2])) {
      flush();
      out.push(button(link[1] ?? 'Open link', link[2]));
    } else if (line.startsWith('- ')) {
      if (paragraph.length) flush();
      list.push(`<li style="margin:0 0 6px">${linkify(escape(line.slice(2)))}</li>`);
    } else {
      if (list.length) flush();
      paragraph.push(linkify(escape(line)));
    }
  }
  flush();
  return out.join('');
}

function footer() {
  const site = siteOrigin();
  const name = process.env.BUSINESS_NAME?.trim() || 'Pirento Blank';
  const address = process.env.BUSINESS_ADDRESS?.trim();
  const support = process.env.SUPPORT_EMAIL?.trim();
  const links = site
    ? ['terms', 'privacy', 'contact']
        .map(
          (page) =>
            `<a href="${escape(`${site}/${page}`)}" style="color:#5f6c70">${page[0].toUpperCase()}${page.slice(1)}</a>`,
        )
        .join(' · ')
    : '';
  return [
    escape(name),
    address ? escape(address) : null,
    support
      ? `Questions? <a href="mailto:${escape(support)}" style="color:#5f6c70">${escape(support)}</a>`
      : null,
    links || null,
    'Pirento Blank is a trading journal and planning tool, not investment advice.',
  ]
    .filter(Boolean)
    .join('<br>');
}

/** The full HTML document for an email with this subject and plain-text body. */
export function emailHtml(subject, text) {
  const body = String(text)
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n\s*\n/)
    .map(renderBlock)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head><body style="margin:0;padding:0;background:#f5f6f2"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f2"><tr><td align="center" style="padding:32px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px"><tr><td style="padding:0 4px 16px;font-size:18px;font-weight:700;color:#2a363b;${FONT}">Pirento <span style="font-weight:400;color:${ACCENT}">Blank</span></td></tr><tr><td style="background:#ffffff;border:1px solid #dce4da;border-radius:12px;padding:32px 28px"><h1 style="margin:0 0 20px;font-size:20px;line-height:1.3;color:#2a363b;${FONT}">${escape(subject)}</h1>${body}</td></tr><tr><td style="padding:20px 4px 0;font-size:12px;line-height:1.6;color:#5f6c70;${FONT}">${footer()}</td></tr></table></td></tr></table></body></html>`;
}
