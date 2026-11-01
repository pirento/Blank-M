/**
 * The branded HTML version of every email, built from its plain text so both parts always say the
 * same thing. In the text:
 * - blank lines separate paragraphs, and "- " starts a list item;
 * - a line that is only a link to this site ("https://…" or "Label: https://…") becomes a button
 *   (the first one solid, later ones outlined), except "Unsubscribe: https://…", which stays a small
 *   muted link;
 * - a run of "Label: value" lines becomes a summary table, a value that is a 6–8 digit code is shown
 *   large, and a value starting with "-" or "+" is coloured as a loss or a gain;
 * - lines starting with "> " are someone's own words and are shown as a quote.
 * Links elsewhere stay plain text, so text a visitor typed can never become a button or a link. The
 * footer carries the business details from the admin panel and links to the legal pages. Colours
 * are the app's palette; layout is table-based with inline styles so it holds up in mail apps.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
const LINK_LINE = /^(?:([^:]{1,60}):\s+)?(https?:\/\/\S+)$/;
const INLINE_LINK = /https?:\/\/[^\s<]+/g;
const FIELD_LINE = /^([^:]{1,40}):\s+(.+)$/;
const CODE = /^\d{6,8}$/;

const COLOR = {
  slate: '#2a363b',
  muted: '#5f6c70',
  line: '#e6e2d8',
  canvas: '#faf6f1',
  sage: '#446e47',
  sageSoft: '#eef3ec',
  peachSoft: '#fff1e6',
  coral: '#ff847c',
  rose: '#bb3348',
};
const DUSK =
  'linear-gradient(90deg,#8eab8a,#adad8c,#c69880,#fecea8,#ff847c,#e84a5f,#7a3d45,#5a363d)';
const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TEXT = `margin:0 0 16px;font-size:15px;line-height:1.65;color:${COLOR.slate};${FONT}`;

/** This site's origin from APP_URL, or '' when it is unset or not a valid URL. */
export const siteOrigin = () => {
  try {
    return new URL(process.env.APP_URL || '').origin;
  } catch {
    return '';
  }
};

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
    ours(url)
      ? `<a href="${url}" style="color:${COLOR.sage};word-break:break-all">${url}</a>`
      : url,
  );

function button(label, href, primary) {
  const fill = primary
    ? `background:${COLOR.sage};border:1px solid ${COLOR.sage};color:#ffffff`
    : `background:#ffffff;border:1px solid ${COLOR.sage};color:${COLOR.sage}`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr><td style="border-radius:8px;${primary ? `background:${COLOR.sage}` : ''}"><a href="${escape(href)}" style="display:inline-block;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;text-decoration:none;${fill};${FONT}">${escape(label)}&nbsp;&rarr;</a></td></tr></table>`;
}

function fieldValue(value) {
  if (CODE.test(value)) {
    return `<span style="display:inline-block;padding:10px 16px;border-radius:8px;background:${COLOR.peachSoft};border:1px dashed ${COLOR.coral};font:600 24px/1 'SFMono-Regular',Menlo,Consolas,monospace;letter-spacing:4px;color:${COLOR.slate}">${escape(value)}</span>`;
  }
  const sign = value.match(/^([-−+])/)?.[1];
  const color = sign === '+' ? COLOR.sage : sign ? COLOR.rose : COLOR.slate;
  return `<span style="color:${color};font-weight:600">${linkify(escape(value))}</span>`;
}

function fieldTable(rows) {
  const body = rows
    .map(
      ([label, value], index) =>
        `<tr><td style="padding:10px 14px;${index ? `border-top:1px solid ${COLOR.line};` : ''}font-size:13px;color:${COLOR.muted};${FONT}">${escape(label)}</td><td align="right" style="padding:10px 14px;${index ? `border-top:1px solid ${COLOR.line};` : ''}font-size:14px;${FONT}">${fieldValue(value)}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;border:1px solid ${COLOR.line};border-radius:10px;border-collapse:separate;background:#fdfbf8">${body}</table>`;
}

function blockquote(lines) {
  return `<div style="margin:4px 0 20px;padding:12px 16px;border-left:3px solid ${COLOR.coral};background:${COLOR.peachSoft};border-radius:0 8px 8px 0;font-size:14px;line-height:1.6;color:${COLOR.slate};${FONT}">${lines.map((line) => escape(line)).join('<br>')}</div>`;
}

function renderBlock(block, state) {
  const out = [];
  let paragraph = [];
  let list = [];
  let fields = [];
  let quoted = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p style="${TEXT}">${paragraph.join('<br>')}</p>`);
    if (list.length) out.push(`<ul style="${TEXT};padding-left:20px">${list.join('')}</ul>`);
    // A single "Label: value" line reads better as a sentence; two or more make a table.
    if (fields.length === 1 && !CODE.test(fields[0][1])) {
      out.push(`<p style="${TEXT}">${linkify(escape(`${fields[0][0]}: ${fields[0][1]}`))}</p>`);
    } else if (fields.length) out.push(fieldTable(fields));
    if (quoted.length) out.push(blockquote(quoted));
    paragraph = [];
    list = [];
    fields = [];
    quoted = [];
  };
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    const link = LINK_LINE.exec(line);
    const field = FIELD_LINE.exec(line);
    // Quoted lines are someone else's words: never a button, whatever they contain.
    if (raw.startsWith('> ') || raw === '>') {
      if (!quoted.length) flush();
      quoted.push(raw.slice(2));
    } else if (link && ours(link[2]) && link[1] === 'Unsubscribe') {
      flush();
      out.push(
        `<p style="margin:8px 0 0;font-size:12px;${FONT}"><a href="${escape(link[2])}" style="color:${COLOR.muted};text-decoration:underline">Unsubscribe</a></p>`,
      );
    } else if (link && ours(link[2])) {
      flush();
      out.push(button(link[1] ?? 'Open link', link[2], !state.buttons++));
    } else if (line.startsWith('- ')) {
      if (!list.length) flush();
      list.push(`<li style="margin:0 0 6px">${linkify(escape(line.slice(2)))}</li>`);
    } else if (field && !/https?:\/\//.test(field[1])) {
      if (!fields.length) flush();
      fields.push([field[1], field[2]]);
    } else {
      if (!paragraph.length) flush();
      paragraph.push(linkify(escape(line)));
    }
  }
  flush();
  return out.join('');
}

function brand() {
  const bars = ['#99b898', '#c69880', '#ff847c']
    .map(
      (color, index) =>
        `<td valign="bottom" style="padding-right:3px"><div style="width:5px;height:${12 + index * 4}px;background:${color};border-radius:1px"></div></td>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>${bars}<td style="padding-left:8px;font-size:19px;font-weight:700;color:#ffffff;${FONT}">Pirento <span style="font-weight:400;color:#b6cdb5">Blank</span></td></tr></table>`;
}

function footer() {
  const site = siteOrigin();
  const name = process.env.BUSINESS_NAME?.trim() || 'Pirento Blank';
  const address = process.env.BUSINESS_ADDRESS?.trim();
  const support = process.env.SUPPORT_EMAIL?.trim();
  const link = (href, label) =>
    `<a href="${escape(href)}" style="color:${COLOR.muted};text-decoration:underline">${escape(label)}</a>`;
  const links = site
    ? ['terms', 'privacy', 'contact']
        .map((page) => link(`${site}/${page}`, `${page[0].toUpperCase()}${page.slice(1)}`))
        .join(' &nbsp;·&nbsp; ')
    : '';
  return [
    `<strong style="color:${COLOR.slate}">${escape(name)}</strong>`,
    address ? escape(address) : null,
    support ? `Questions? ${link(`mailto:${support}`, support)}` : null,
    links || null,
    'Pirento Blank is a trading journal and planning tool, not investment advice.',
  ]
    .filter(Boolean)
    .join('<br>');
}

/** The full HTML document for an email with this subject and plain-text body. */
export function emailHtml(subject, text) {
  const clean = String(text).replace(/\r\n/g, '\n').trim();
  const state = { buttons: 0 };
  const body = clean
    .split(/\n\s*\n/)
    .map((block) => renderBlock(block, state))
    .join('');
  // The inbox preview: the first sentence of the email, never a raw link.
  const preview = (clean.split('\n').find((line) => line.trim() && !/https?:\/\//.test(line)) ?? '')
    .replace(/^> /, '')
    .slice(0, 140);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escape(subject)}</title><style>@media (max-width:620px){.card{padding:26px 20px!important}.shell{padding:16px 8px!important}h1{font-size:20px!important}}</style></head><body style="margin:0;padding:0;background:${COLOR.canvas};-webkit-text-size-adjust:100%"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escape(preview)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${COLOR.canvas}" style="background:${COLOR.canvas}"><tr><td align="center" class="shell" style="padding:32px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px"><tr><td bgcolor="${COLOR.slate}" style="background:${COLOR.slate};border-radius:14px 14px 0 0;padding:20px 28px">${brand()}</td></tr><tr><td height="4" bgcolor="#c69880" style="height:4px;line-height:4px;font-size:0;background:#c69880;background-image:${DUSK}">&nbsp;</td></tr><tr><td class="card" bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${COLOR.line};border-top:0;border-radius:0 0 14px 14px;padding:34px 32px 30px"><h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;font-weight:600;color:${COLOR.slate};${FONT}">${escape(subject)}</h1><div style="width:48px;height:3px;margin:0 0 24px;border-radius:2px;background:${COLOR.sage};background-image:linear-gradient(90deg,#99b898,#fecea8,#ff847c,#e84a5f)"></div>${body}</td></tr><tr><td style="padding:22px 8px 0;font-size:12px;line-height:1.7;color:${COLOR.muted};${FONT}">${footer()}</td></tr></table></td></tr></table></body></html>`;
}
