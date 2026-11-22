// mend — one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
// Reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form, finds the
// lines each edit names at the first of three whitespace tiers, and writes
// every change or none. In a trial (MAKEFUN_ENV_URL set) it hands over to
// runner.ts, exactly as the kit requires; that hand-over is at the bottom.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function requireSafe(p: string): void {
  if (!safePath(p)) throw new Fail('unsafe', p);
}

// ---------- file model (SPEC section 3) ----------

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeFile(fs: FileState): string {
  if (fs.lines.length === 0) return '';
  return fs.lines.join(fs.br) + (fs.final ? fs.br : '');
}

// ---------- the virtual tree ----------

interface Move {
  from: string;
  to: string;
}

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Move[] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }

  state(p: string): FileState {
    const t = this.get(p);
    if (t === null) throw new Fail('missing', p);
    return parseFile(t);
  }

  putState(p: string, fs: FileState): void {
    this.now.set(p, writeFile(fs));
  }
}

type Edit = (tree: Tree, strict: boolean) => void;

// ---------- line matching at three tiers (SPEC section 5) ----------

const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? rtrimWs(s) : trimWs(s);
}

interface TierHit {
  tier: number;
  positions: number[];
}

function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  const want = old.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function firstTier(lines: string[], old: string[], strict: boolean, from = 0, eofOnly = false): TierHit | null {
  const lastTier = strict ? 0 : 2;
  for (let tier = 0; tier <= lastTier; tier += 1) {
    let pos = occurrencesAt(lines, old, tier, from);
    if (eofOnly) pos = pos.filter((i) => i + old.length === lines.length);
    if (pos.length > 0) return { tier, positions: pos };
  }
  return null;
}

// One entry of a replacement body: a context line (shared with the old
// lines) or a newly written line.
interface BodyLine {
  kind: 'ctx' | 'new';
  text: string;
  oIndex: number; // index into the old lines, for context lines
  backslash: boolean; // a "\ No newline" line follows this body line
}

// Build the replacement lines for a match at `pos`, honouring the tier
// rules: context lines come from the file itself, and at tier 2 the new
// lines are re-indented from the old first line's indent to the file's.
function buildReplacement(fileLines: string[], pos: number, old: string[], body: BodyLine[], tier: number): string[] {
  const out: string[] = [];
  const fileLead = old.length > 0 ? leadWs(fileLines[pos]!) : '';
  const patchLead = old.length > 0 ? leadWs(old[0]!) : '';
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(fileLines[pos + b.oIndex]!);
    } else {
      let t = b.text;
      if (tier === 2 && old.length > 0 && t !== '' && t.trim() !== '' && t.startsWith(patchLead)) {
        t = fileLead + t.slice(patchLead.length);
      }
      out.push(t);
    }
  }
  return out;
}

// Replacement for formats whose new lines are all plain new lines
// (SEARCH/REPLACE): wrap them as body lines and reuse the tier rules.
function plainReplacement(fileLines: string[], pos: number, old: string[], fresh: string[], tier: number): string[] {
  const body: BodyLine[] = fresh.map((text) => ({ kind: 'new', text, oIndex: -1, backslash: false }));
  return buildReplacement(fileLines, pos, old, body, tier);
}

// ---------- unified diffs (SPEC section 6) ----------

interface UHunk {
  a: number;
  entries: { kind: 'ctx' | 'minus' | 'plus'; text: string; backslash: boolean }[];
}

interface USection {
  diffOld?: string;
  diffNew?: string;
  minusPath?: string;
  plusPath?: string;
  renameFrom?: string;
  renameTo?: string;
  isNew: boolean;
  isDeleted: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function cleanHeaderPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseDiffGit(line: string, lineNo: number): { x: string; y: string } {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const sep = rest.indexOf(' b/');
  if (sep < 3) throw new Exit2(`error: parse ${lineNo}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineNo}`);
  return { x, y };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let hunk: UHunk | null = null;
  let inBody = false;

  const newSection = (): USection => {
    const s: USection = { isNew: false, isDeleted: false, hunks: [] };
    sections.push(s);
    sec = s;
    hunk = null;
    inBody = false;
    return s;
  };
  const closeHunk = (): void => {
    if (hunk !== null) {
      while (hunk.entries.length > 0) {
        const last = hunk.entries[hunk.entries.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.entries.pop();
        else break;
      }
    }
    hunk = null;
    inBody = false;
  };
  const startHunk = (line: string, lineNo: number): void => {
    const m = HUNK_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${lineNo}`);
    if (sec === null) throw new Exit2(`error: parse ${lineNo}`);
    closeHunk();
    hunk = { a: parseInt(m[1]!, 10), entries: [] };
    sec.hunks.push(hunk);
    inBody = true;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const no = i + 1;
    if (line.startsWith('diff --git ')) {
      const { x, y } = parseDiffGit(line, no);
      closeHunk();
      const s = newSection();
      s.diffOld = x;
      s.diffNew = y;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A header pair: it belongs to the current section when that section
      // has no pair and no hunk yet, otherwise it opens a new section.
      if (sec !== null && !inBody && sec.hunks.length === 0 && sec.minusPath === undefined) {
        sec.minusPath = cleanHeaderPath(line.slice(4));
        sec.plusPath = cleanHeaderPath(lines[i + 1]!.slice(4));
      } else {
        closeHunk();
        const s = newSection();
        s.minusPath = cleanHeaderPath(line.slice(4));
        s.plusPath = cleanHeaderPath(lines[i + 1]!.slice(4));
      }
      i += 1;
      continue;
    }
    if (inBody && hunk !== null) {
      const c = line[0];
      if (c === ' ' || c === '-' || c === '+' || c === '\\' || line === '') {
        if (c === '\\') {
          const prev = hunk.entries[hunk.entries.length - 1];
          if (prev !== undefined) prev.backslash = true;
        } else if (line === '') {
          hunk.entries.push({ kind: 'ctx', text: '', backslash: false });
        } else {
          hunk.entries.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'minus' : 'plus', text: line.slice(1), backslash: false });
        }
        continue;
      }
      closeHunk();
      // fall through: the line is handled as outside-body content below
    }
    if (line.startsWith('@@')) {
      startHunk(line, no);
      continue;
    }
    if (sec === null) continue; // prose before the first section
    if (sec.hunks.length === 0 && !inBody) {
      // section header lines, before the first hunk
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${no + 1}`);
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.isNew = true;
      else if (line.startsWith('deleted file mode')) sec.isDeleted = true;
      continue;
    }
    // lines between hunks or after the last hunk are ignored
  }
  closeHunk();
  return sections;
}

function unifiedSectionEdit(sec: USection): Edit {
  return (tree, strict) => {
    const oldPath = sec.minusPath !== undefined ? sec.minusPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const newPath = sec.plusPath !== undefined ? sec.plusPath : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    const creation = oldPath === '/dev/null' || sec.isNew;
    const deletion = !creation && (newPath === '/dev/null' || sec.isDeleted);

    if (creation) {
      const p = newPath;
      if (p === undefined || p === '/dev/null') throw new Fail('missing', p ?? '');
      requireSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const outLines: string[] = [];
      let lastPlusBackslash = false;
      let sawPlus = false;
      for (const h of sec.hunks) {
        for (const e of h.entries) {
          if (e.kind === 'plus') {
            outLines.push(e.text);
            sawPlus = true;
            lastPlusBackslash = e.backslash;
          }
        }
      }
      const fs: FileState = { lines: outLines, br: '\n', final: sawPlus ? !lastPlusBackslash : false };
      tree.set(p, writeFile(fs));
      return;
    }
    if (deletion) {
      const p = oldPath;
      if (p === undefined || p === '/dev/null') throw new Fail('missing', p ?? '');
      requireSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    // change or move
    const from = oldPath;
    const to = newPath;
    if (from === undefined) throw new Fail('missing', from ?? '');
    requireSafe(from);
    if (to !== undefined && to !== from) requireSafe(to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    const isMove = to !== undefined && to !== from;
    if (isMove && tree.get(to!) !== null) throw new Fail('exists', to!);

    const fs = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const old: string[] = [];
      const body: BodyLine[] = [];
      for (const e of h.entries) {
        if (e.kind === 'ctx') {
          body.push({ kind: 'ctx', text: e.text, oIndex: old.length, backslash: e.backslash });
          old.push(e.text);
        } else if (e.kind === 'minus') {
          old.push(e.text);
        } else {
          body.push({ kind: 'new', text: e.text, oIndex: -1, backslash: e.backslash });
        }
      }
      if (old.length === 0) {
        const fresh = body.map((b) => b.text);
        const at = Math.min(h.a + d, fs.lines.length);
        const atEnd = at === fs.lines.length;
        fs.lines.splice(at, 0, ...fresh);
        if (atEnd && fresh.length > 0) {
          const lastNew = body[body.length - 1]!;
          fs.final = !lastNew.backslash;
        }
        d += fresh.length;
        continue;
      }
      const hit = firstTier(fs.lines, old, strict);
      if (hit === null) throw new Fail('no-match', from);
      const target = h.a - 1 + d;
      let pos = hit.positions[0]!;
      let best = Math.abs(pos - target);
      for (const cand of hit.positions) {
        const dist = Math.abs(cand - target);
        if (dist < best) {
          best = dist;
          pos = cand;
        }
      }
      const runsToEnd = pos + old.length === fs.lines.length;
      const replacement = buildReplacement(fs.lines, pos, old, body, hit.tier);
      fs.lines.splice(pos, old.length, ...replacement);
      if (runsToEnd) {
        const lastN = body[body.length - 1];
        // With no new line at all the file now ends at a line that was
        // followed by a break; otherwise the last written line decides.
        if (lastN === undefined) fs.final = true;
        else fs.final = !lastN.backslash;
      }
      d += replacement.length - old.length;
    }
    if (isMove) {
      tree.set(to!, writeFile(fs));
      tree.set(from, null);
      tree.moves.push({ from, to: to! });
    } else {
      tree.putState(from, fs);
    }
  };
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map(unifiedSectionEdit);
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let lastPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    // the path: nearest line before SEARCH, after the previous block,
    // that is not blank and does not start with three backticks
    let path: string | undefined;
    const startScan = blocks.length === 0 && lastPath === undefined ? 0 : scanFrom;
    for (let j = i - 1; j >= startScan; j -= 1) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === undefined) path = lastPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchNo}`);
    // find ======= then >>>>>>> REPLACE
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNo}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchNo}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, end) });
    lastPath = path;
    scanFrom = end + 1;
    i = end + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

let scanFrom = 0;

function searchReplaceEdits(lines: string[]): Edit[] {
  scanFrom = 0;
  const blocks = parseSearchReplace(lines);
  return blocks.map((b): Edit => {
    return (tree, strict) => {
      requireSafe(b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        const fs: FileState = { lines: [...b.newLines], br: '\n', final: b.newLines.length > 0 };
        tree.set(b.path, writeFile(fs));
        return;
      }
      const fs = tree.state(b.path);
      const hit = firstTier(fs.lines, b.oldLines, strict);
      if (hit === null) throw new Fail('no-match', b.path);
      if (hit.positions.length > 1) throw new Fail('ambiguous', b.path);
      const pos = hit.positions[0]!;
      const replacement = plainReplacement(fs.lines, pos, b.oldLines, b.newLines, hit.tier);
      fs.lines.splice(pos, b.oldLines.length, ...replacement);
      tree.putState(b.path, fs);
    };
  });
}

// ---------- V4A patches (SPEC section 8) ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: { kind: 'ctx' | 'minus' | 'plus'; text: string }[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo?: string;
  addLines: string[];
  chunks: VChunk[];
  startLine: number;
}

function parseV4a(lines: string[]): VSection[] {
  const firstIdx = lines.findIndex((l) => !isBlank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i]!)) {
      lastIdx = i;
      break;
    }
  }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let sec: VSection | null = null;
  let chunk: VChunk | null = null;
  const closeSection = (): void => {
    if (sec !== null && sec.kind === 'upd' && sec.chunks.length === 0 && sec.moveTo === undefined) {
      throw new Exit2(`error: parse ${sec.startLine}`);
    }
    if (sec !== null && sec.kind === 'upd' && sec.chunks.length > 0) {
      // Blank lines at the end of a section are not part of it: drop the
      // empty context lines they added to the last chunk.
      const last = sec.chunks[sec.chunks.length - 1]!;
      while (last.entries.length > 0) {
        const e = last.entries[last.entries.length - 1]!;
        if (e.kind === 'ctx' && e.text === '') last.entries.pop();
        else break;
      }
    }
    // blank lines at the end of an Add section are not part of it: they
    // were collected as empty file lines only when followed by more lines
    sec = null;
    chunk = null;
  };

  for (let i = firstIdx + 1; i < lastIdx; i += 1) {
    const line = lines[i]!;
    const no = i + 1;
    if (line.startsWith('*** Add File: ')) {
      closeSection();
      sec = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), addLines: [], chunks: [], startLine: no };
      sections.push(sec);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      closeSection();
      sec = { kind: 'del', path: line.slice('*** Delete File: '.length).trim(), addLines: [], chunks: [], startLine: no };
      sections.push(sec);
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      closeSection();
      sec = { kind: 'upd', path: line.slice('*** Update File: '.length).trim(), addLines: [], chunks: [], startLine: no };
      sections.push(sec);
      continue;
    }
    if (sec === null) {
      if (isBlank(line)) continue;
      throw new Exit2(`error: parse ${no}`);
    }
    if (sec.kind === 'add') {
      if (line.startsWith('+')) sec.addLines.push(line.slice(1));
      else if (line === '') sec.addLines.push('');
      else throw new Exit2(`error: parse ${no}`);
      continue;
    }
    if (sec.kind === 'del') {
      if (isBlank(line)) continue; // blank lines between sections
      throw new Exit2(`error: parse ${no}`);
    }
    // update section
    if (sec.chunks.length === 0 && chunk === null && line.startsWith('*** Move to: ')) {
      sec.moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      chunk = { anchor: line.slice(2).trim() === '' ? null : line.slice(2).trim(), eof: false, entries: [] };
      sec.chunks.push(chunk);
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (chunk === null) {
        chunk = { anchor: null, eof: true, entries: [] };
        sec.chunks.push(chunk);
      } else chunk.eof = true;
      continue;
    }
    const c = line[0];
    if (c === ' ' || c === '-' || c === '+' || line === '') {
      if (chunk === null) {
        chunk = { anchor: null, eof: false, entries: [] };
        sec.chunks.push(chunk);
      }
      if (line === '') chunk.entries.push({ kind: 'ctx', text: '' });
      else chunk.entries.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'minus' : 'plus', text: line.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  closeSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function v4aEdits(lines: string[]): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((sec): Edit => {
    return (tree, strict) => {
      requireSafe(sec.path);
      if (sec.kind === 'add') {
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        const kept = [...sec.addLines];
        while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
        const fs: FileState = { lines: kept, br: '\n', final: true };
        tree.set(sec.path, writeFile(fs));
        return;
      }
      if (sec.kind === 'del') {
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.set(sec.path, null);
        return;
      }
      // update
      if (sec.moveTo !== undefined) requireSafe(sec.moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      const fs = parseFile(before);
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          const anchorLines = [ch.anchor];
          const hit = firstTier(fs.lines, anchorLines, strict, cursor);
          if (hit === null) throw new Fail('no-match', sec.path);
          cursor = hit.positions[0]! + 1;
        }
        const old: string[] = [];
        const body: BodyLine[] = [];
        for (const e of ch.entries) {
          if (e.kind === 'ctx') {
            body.push({ kind: 'ctx', text: e.text, oIndex: old.length, backslash: false });
            old.push(e.text);
          } else if (e.kind === 'minus') old.push(e.text);
          else body.push({ kind: 'new', text: e.text, oIndex: -1, backslash: false });
        }
        if (old.length === 0) {
          const fresh = body.map((b) => b.text);
          const at = ch.eof ? fs.lines.length : Math.min(cursor, fs.lines.length);
          fs.lines.splice(at, 0, ...fresh);
          cursor = at + fresh.length;
          continue;
        }
        const hit = firstTier(fs.lines, old, strict, cursor, ch.eof);
        if (hit === null) throw new Fail('no-match', sec.path);
        const pos = hit.positions[0]!;
        const replacement = buildReplacement(fs.lines, pos, old, body, hit.tier);
        fs.lines.splice(pos, old.length, ...replacement);
        cursor = pos + replacement.length;
      }
      if (sec.moveTo !== undefined) {
        tree.set(sec.moveTo, writeFile(fs));
        tree.set(sec.path, null);
        tree.moves.push({ from: sec.path, to: sec.moveTo });
      } else {
        tree.putState(sec.path, fs);
      }
    };
  });
}

// ---------- JSON edits (SPEC section 9) ----------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      requireSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      requireSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      requireSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const fs = parseFile(before);
      if (line < 0 || line > fs.lines.length) throw new Fail('no-match', p);
      fs.lines.splice(line, 0, ...add);
      tree.putState(p, fs);
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------- format detection (SPEC section 4) ----------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- the command line (SPEC sections 1, 2 and 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !checkOnly) checkOnly = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }

  // Changed paths, with move pairs folded into R lines (section 2).
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const byPath = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const consumed = new Set<string>();
  interface Row {
    key: string;
    text: string;
    paths: string[];
  }
  const rows: Row[] = [];
  for (const mv of tree.moves) {
    const oldGone = changed.includes(mv.from) && tree.now.get(mv.from) === null;
    const newThere = changed.includes(mv.to) && tree.original(mv.to) === null && tree.now.get(mv.to) !== null;
    if (oldGone && newThere && !consumed.has(mv.from) && !consumed.has(mv.to)) {
      rows.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}`, paths: [mv.from, mv.to] });
      consumed.add(mv.from);
      consumed.add(mv.to);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, paths: [p] });
  }
  rows.sort((a, b) => byPath(a.key, b.key));
  if (!checkOnly) {
    const written = new Set<string>();
    for (const row of rows) {
      for (const p of row.paths) {
        if (written.has(p)) continue;
        written.add(p);
        const now = tree.now.get(p)!;
        if (now === null) rmSync(p, { force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
