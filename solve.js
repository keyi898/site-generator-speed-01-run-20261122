// A fast drop-in for makefun-site 1.0.0: builds one site's output tree exactly as
// makefun-site does, but with a fused, allocation-light implementation written
// from the documented rules (front matter, template dialect, Markdown subset,
// slug rule and report). Pure JavaScript, no dependencies, no network, no I/O.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ text */

// HTML escaping: & < > " ' only. One shared regex; each call runs it to
// completion, so no interleaving can disturb it.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function esc(s) {
  let out = '';
  let last = 0;
  let m;
  ESC_RE.lastIndex = 0;
  while ((m = ESC_RE.exec(s)) !== null) {
    out += s.slice(last, m.index) + ESC[m[0]];
    last = m.index + 1;
  }
  return last === 0 ? s : out + s.slice(last);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  // "2026-11-09" -> "9 November 2026", from the string alone.
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run of
// characters other than a-z and 0-9 one "-", none at either end, at most 64
// characters (a "-" left at the cut dropped), "untitled" when nothing is left.
const MARKS_RE = /\p{M}/gu;
const NON_SLUG_RE = /[^a-z0-9]+/g;
const slugCache = new Map();
function slugify(text) {
  let out = slugCache.get(text);
  if (out !== undefined) return out;
  const plain = text.normalize('NFKD').replace(MARKS_RE, '').toLowerCase();
  out = plain.replace(NON_SLUG_RE, '-').replace(/^-+/, '').replace(/-+$/, '');
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  if (slugCache.size < 8192) slugCache.set(text, out);
  return out;
}

// `slug` made unique against `taken` (and added to it).
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/* ------------------------------------------------------------ front matter */

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isLowerKeyChar(code) {
  return (code >= 97 && code <= 122) || code === 95; // a-z or _
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function rstripTabs(line) {
  let e = line.length;
  while (e > 0) {
    const c = line.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return e === line.length ? line : line.slice(0, e);
}

// A quoted string: "..." whose only escapes are \" and \\.
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return 'a quoted string is not closed';
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return 'a quoted string holds an escape other than \\" or \\\\';
        out += n;
        i++;
      } else if (c === '"') return 'a quoted string holds a stray quote';
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return 'a bare string opens on [';
  return { value: raw };
}

// One key's value, or the reason it is refused (a string).
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return typeof s === 'string' ? `key "${key}": ${s}` : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return 'key "tags": not a list [a, b]';
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) tags[i] = tags[i].trim();
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] === '' || !TAG_RE.test(tags[i])) return 'key "tags": an empty tag, or one holding " [ or ]';
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : 'key "draft": true or false';
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : 'key "layout": not a template name';
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : 'key "slug": not a slug';
    default:
      return `unknown key "${key}"`;
  }
}

// A source's front matter and body: { data, body }, or { error }.
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // Scan lines from offset `pos`; lineNo is 1-based (opening "---" is line 1).
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let lineNo = 1;
  const data = {};
  while (true) {
    if (pos > text.length) return { error: 'the front matter is not closed' };
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    lineNo++;
    if (line === '---') {
      const body = nl === -1 ? '' : text.slice(nl + 1);
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body };
    }
    if (pos >= text.length && nl === -1 && line === '') return { error: 'the front matter is not closed' };
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      // Must be "key: value": key of a-z and _, colon, one space, value.
      let k = 0;
      while (k < line.length && isLowerKeyChar(line.charCodeAt(k))) k++;
      if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) {
        return { error: `line ${lineNo} is not "key: value"` };
      }
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      raw = rstripTabs(raw);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if (typeof v === 'string') return { error: v };
      data[key] = v.value;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
  }
}

/* --------------------------------------------------------------- markdown */

// The characters a backslash escapes.
function isEscapable(c) {
  return c === '\\' || c === '`' || c === '*' || c === '_' || c === '[' || c === ']' ||
    c === '(' || c === ')' || c === '#' || c === '+' || c === '-' || c === '.' ||
    c === '!' || c === '>';
}

// First index from `from` where `s` holds `what` outside a backslash escape.
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// First single * from `from` (one whose run is not **), outside an escape.
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// Index of the next inline-special character at or after `i`, or -1.
// One shared regex: every use sets lastIndex first, so recursion (inlineTo
// calls itself) cannot disturb an outer scan.
const SPECIAL_RE = /[\\`*[]/g;
function nextSpecial(s, i) {
  SPECIAL_RE.lastIndex = i;
  const m = SPECIAL_RE.exec(s);
  return m === null ? -1 : m.index;
}

// `s` rendered inline, its chunks pushed to `out`; env.link resolves hrefs.
function inlineTo(s, env, out) {
  let i = 0;
  let plain = 0; // start of the current run of plain text
  const n = s.length;
  while (true) {
    const j = nextSpecial(s, i);
    if (j === -1) break;
    const c = s[j];
    if (c === '\\') {
      const d = s[j + 1];
      if (d !== undefined && isEscapable(d)) {
        if (j > plain) out.push(esc(s.slice(plain, j)));
        out.push(esc(d)); // the escaped character itself, HTML-escaped
        i = j + 2;
        plain = i;
      } else {
        i = j + 1; // a lone backslash is itself; keep it in the plain run
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(esc(s.slice(plain, j)));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
      } else {
        i = j + 1; // no closer (or empty span): the backtick is itself
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > plain) out.push(esc(s.slice(plain, j)));
          out.push('<strong>');
          inlineTo(s.slice(j + 2, k), env, out);
          out.push('</strong>');
          i = k + 2;
          plain = i;
        } else {
          i = j + 2; // no closer: both stars are themselves
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(esc(s.slice(plain, j)));
        out.push('<em>');
        inlineTo(s.slice(j + 1, k), env, out);
        out.push('</em>');
        i = k + 1;
        plain = i;
      } else {
        i = j + 1; // no closer: the star is itself
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      if (j > plain) out.push(esc(s.slice(plain, j)));
      out.push('<a href="', esc(env.link(target)), '">');
      inlineTo(s.slice(j + 1, k), env, out);
      out.push('</a>');
      i = m + 1;
      plain = i;
    } else {
      i = j + 1; // not a link: the bracket is itself
    }
  }
  if (n > plain) out.push(esc(s.slice(plain)));
}

function inline(s, env) {
  const out = [];
  inlineTo(s, env, out);
  return out.join('');
}

// Trim spaces and tabs at both ends of a line.
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isLangChar(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
    code === 95 || code === 43 || code === 45; // A-Z a-z 0-9 _ + -
}

// Only spaces/tabs from `from` to the end of `line`.
function onlySpacesTabs(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A fence opening line: ``` + optional language, then spaces/tabs only.
// Returns the language, or null.
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  if (!onlySpacesTabs(line, j)) return null;
  return line.slice(3, j);
}

function fenceClose(line) {
  return line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && onlySpacesTabs(line, 3);
}

// A heading line: 1-6 #, at least one space/tab, then non-blank text.
// Returns { depth, text } or null.
function headingOf(line) {
  let h = 0;
  while (h < 6 && line.charCodeAt(h) === 35) h++;
  if (h === 0) return null;
  const after = line.charCodeAt(h);
  if (after !== 32 && after !== 9) return null;
  let t = h;
  while (t < line.length && (line.charCodeAt(t) === 32 || line.charCodeAt(t) === 9)) t++;
  let e = line.length;
  while (e > t && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === t) return null;
  return { depth: h, text: line.slice(t, e) };
}

function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  return onlySpacesTabs(line, 3);
}

// Whether `line` ends a paragraph: blank, fence, heading or thematic break.
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

const CONTINUED_RE = /^ {2,}\S/;

// A list item's first line: returns { ordered, start, text } or null.
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    return { ordered: false, start: 1, text: trimLine(line.slice(2)) };
  }
  let d = 0;
  while (d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d >= 1 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
    return { ordered: true, start: Number(line.slice(0, d)), text: trimLine(line.slice(d + 2)) };
  }
  return null;
}

// `src` rendered: { html, toc, excerpt }.
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < total && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let code = '';
      for (let q = 0; q < body.length; q++) code += esc(body[q]) + '\n';
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${esc(lang)}"`}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < total && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (let q = 0; q < body.length; q++) {
        const t = trimLine(body[q]);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const first = listStart(line);
    if (first !== null) {
      const isOrdered = first.ordered;
      const items = [[first.text]];
      i++;
      while (i < total) {
        const next = listStart(lines[i]);
        if (next !== null && next.ordered === isOrdered) {
          items.push([next.text]);
          i++;
        } else if (CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && first.start !== 1 ? `<ol start="${first.start}">` : `<${tag}>`;
      let listHtml = `${open}\n`;
      for (let q = 0; q < items.length; q++) listHtml += `<li>${inline(items[q].join('\n'), env)}</li>\n`;
      blocks.push(`${listHtml}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

/* --------------------------------------------------------------- templates */

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Tokenize a template: text, {{ }}, {{{ }}} and {% %} tokens; a standalone
// {% %} tag takes its whole line with it.
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlankLine(src.slice(lineStart, open)) && isBlankLine(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Parse a template into its node tree (a TemplateError when it does not parse).
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// The value at `path` in the scope chain.
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

// A value as text: string itself, a number in JavaScript's digits, true or
// false, an array's items joined by ", ", anything else "".
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

// Whether a value counts as true in an if.
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Render `nodes` in `scope`, pushing chunks to `out`. Include nodes carry
// their target's nodes already resolved (see run), so rendering needs no
// template lookup.
function renderNodes(nodes, scope, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, depth, out);
        }
        break;
      }
      case 'include': {
        if (n.nodes !== undefined && depth < INCLUDE_DEPTH) renderNodes(n.nodes, scope, depth + 1, out);
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------- build */

// The words of a body: runs of characters other than whitespace. ASCII
// whitespace is a table lookup; the rest is the small non-ASCII set.
const WS_TAB = new Uint8Array(128);
for (const cc of [32, 9, 10, 13, 11, 12]) WS_TAB[cc] = 1;
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const ws = code < 128 ? WS_TAB[code] === 1 : code === 160 || code === 5760 ||
      (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 ||
      code === 8239 || code === 8287 || code === 12288 || code === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// `rel` from the directory `dir` of a source, or null when it climbs out.
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// One site's output tree: path -> text.
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  // Resolve every include to its target's nodes now, once: rendering then
  // needs no template lookup per include.
  const resolveIncludes = (nodes) => {
    for (const n of nodes) {
      if (n.kind === 'include') n.nodes = templates.get(n.name);
      else if (n.kind === 'for') resolveIncludes(n.body);
      else if (n.kind === 'if') {
        resolveIncludes(n.then);
        if (n.else !== null) resolveIncludes(n.else);
      }
    }
  };
  for (const nodes of templates.values()) resolveIncludes(nodes);
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    // Line ends made "\n"; most sources hold no "\r" at all.
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the checks, in order; a refused source is reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let ownDir = null;
    if (s.path.startsWith('tags/')) ownDir = 'tags';
    else if (s.path.startsWith('page/')) ownDir = 'page';
    if (ownDir !== null) {
      report.push(`refused ${s.path}: ${ownDir}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's directory, slug and url.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOf(s.body);
  }

  // Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, each named as first met walking the posts in
  // collection order, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const names = s.data.tags ?? [];
    const out = [];
    for (let i = 0; i < names.length; i++) {
      const slug = slugify(names[i]);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(names[i]);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages and the layouts.
  const cards = new Map();
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const p of posts) cards.set(p, cardOf(p));

  const linkOf = (s) => (s === null ? null : {
    title: s.data.title, url: s.url, date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const pageOf = (s) => {
    const card = s.post ? cards.get(s) : cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  const tagOf = (t) => ({
    name: t.name, slug: t.slug, url: t.url, count: t.posts.length,
    posts: t.posts.map((p) => cards.get(p)),
  });

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // One shared root scope holds site/tags/recent; each render adds its own
  // vars as a child scope, which lookup checks first — the same resolution
  // as one merged object, without building it per render.
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: rootScope }, 0, out);
    return out.join('');
  };

  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted,
  // then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
