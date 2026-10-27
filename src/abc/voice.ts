import type { ScoreEvent } from '../expand.ts'
import type { Clef } from '../families.ts'
import type { Rendering } from '../render.ts'
import type { Pedal } from '../words.ts'
import { DRUMS } from '../words.ts'
import { BAR, BEAT, NOTE_LENGTHS, REST_LENGTHS, keyName, median, nearestDynamic, onGrid, speller, split } from './spell.ts'

export interface Sheet extends Pick<Rendering, 'keys' | 'mode' | 'tonic' | 'bars'> {
  labels: { bar: number; label: string }[]
}

export interface VoiceStyle {
  inner: boolean
  rings: boolean
  clef: Clef
  drum?: boolean
}

interface Onset {
  pos: number
  midis: Set<number>
  end: number
  arpeggio: boolean
  accent: boolean
  levels: number[]
  shift: number
}

const OTTAVA_TOP = 88
const OTTAVA_FLOOR = 72
const SIMILE_AFTER = 2

// A drum hit needs a staff position, not a pitch. abcjs turns a percussion note into a percmap key
// with pitches-to-perc: (accidental ?? 'x') + verticalPos, then reads pitchMap, whose values are the
// note names — so "C" at position 0, "c" at 7, "c'" at 14, and "^D" for a sharpened D. That note name
// is what a %%percmap line must be keyed by. pitchMap stops at 16, so the last two hits borrow an
// accidental on the low lines rather than climbing off the table. The letters are ABC's octave marks
// (lowercase, then apostrophes), never digits, because a digit after a note is its length.
// GM keys are sorted so a hit always lands on the same line, whatever order the parts come in.
const DRUM_LETTERS = 'CDEFGAB'
const DRUM_MIDIS = [...new Set(Object.values(DRUMS))].sort((a, b) => a - b)
const DRUM_POSITIONS: Record<number, number> = Object.fromEntries(DRUM_MIDIS.map((midi, i) => [midi, i]))

const abcPitch = (pos: number) => {
  if (pos > 18) throw new Error(`drum position ${pos} has no abcjs key; pitchMap reaches 0-16 and two more borrow a sharp`)
  if (pos > 16) return `^${DRUM_LETTERS[(pos - 17) * 2 + 1]}`
  const letter = DRUM_LETTERS[pos % 7]
  if (pos < 7) return letter
  return letter.toLowerCase() + "'".repeat(Math.floor(pos / 7) - 1)
}

// abcjs only accepts a GM sound 35-81, so a hit below that keeps its line but borrows a nearby sound.
const percSound = (midi: number) => (midi >= 35 && midi <= 81 ? midi : 35)

export const drumMap = (events: ScoreEvent[]) => {
  const used = [...new Set(events.map((e) => e.midi))].filter((m) => m in DRUM_POSITIONS).sort((a, b) => a - b)
  return used.map((midi) => ({ pos: DRUM_POSITIONS[midi], pitch: abcPitch(DRUM_POSITIONS[midi]), midi, sound: percSound(midi) }))
}

const onsets = (events: ScoreEvent[]) => {
  const byPos = new Map<number, Onset>()
  for (const e of events) {
    const grid = onGrid(e.offset)
    const pos = e.step * 2 + (grid ? e.offset * 2 : 0)
    const onset = byPos.get(pos) ?? { pos, midis: new Set(), end: pos, arpeggio: false, accent: false, levels: [], shift: 0 }
    onset.midis.add(e.midi)
    onset.end = Math.max(onset.end, pos + e.written * 2)
    onset.arpeggio ||= e.rolled && !grid
    onset.accent ||= e.velocity > e.level + 0.04
    onset.levels.push(e.level)
    byPos.set(pos, onset)
  }
  return [...byPos.values()].sort((a, b) => a.pos - b.pos)
}

const ottava = (list: Onset[]) => {
  let high = false
  const marks: [number, string][] = []
  for (const o of list) {
    const lo = Math.min(...o.midis)
    const hi = Math.max(...o.midis)
    if (!high && hi >= OTTAVA_TOP && lo >= OTTAVA_FLOOR) marks.push([o.pos, '"^8va"'])
    else if (high && lo < OTTAVA_FLOOR) marks.push([o.pos, '"^loco"'])
    high = lo >= OTTAVA_FLOOR && (high || hi >= OTTAVA_TOP)
    o.shift = high ? 12 : 0
  }
  return marks
}

const pedalMarks = (pedals: Pedal[], bars: number) => {
  const marks = new Map<number, string>()
  let down = false
  for (const p of pedals) {
    const pos = Math.round(p.at * 2)
    const text = p.down ? (down ? '✱ Ped.' : 'Ped.') : down ? '✱' : ''
    down = p.down
    if (!text || pos >= bars * BAR) continue
    marks.set(pos, marks.get(pos) === '✱' && text === 'Ped.' ? '✱ Ped.' : text)
  }
  const routine = (bar: number) => {
    const inBar = [...marks].filter(([pos]) => Math.floor(pos / BAR) === bar)
    return inBar.length === 1 && inBar[0][0] === bar * BAR && inBar[0][1] === '✱ Ped.'
  }
  let shown = 0
  for (let bar = 0; bar < bars; bar++) {
    if (!routine(bar)) continue
    shown++
    if (shown === SIMILE_AFTER + 1) marks.set(bar * BAR, 'sim.')
    else if (shown > SIMILE_AFTER + 1) marks.delete(bar * BAR)
  }
  return marks
}

export const pedalVoice = (pedals: Pedal[], bars: number) => {
  const marks = pedalMarks(pedals, bars)
  return Array.from({ length: bars }, (_, bar) => {
    const start = bar * BAR
    const stops = [...new Set([0, ...[...marks.keys()].filter((pos) => Math.floor(pos / BAR) === bar).map((pos) => pos - start), BAR])].sort((a, b) => a - b)
    return stops
      .slice(0, -1)
      .flatMap((at, i) =>
        split(at, stops[i + 1] - at, REST_LENGTHS).map((len, j) => {
          const text = j === 0 ? marks.get(start + at) : undefined
          return `${text ? `"_${text}"` : ''}x${len === 1 ? '' : len}`
        }),
      )
      .join(' ')
  })
}

export const writeVoice = (sheet: Sheet, style: VoiceStyle, events: ScoreEvent[], top: boolean, said: Map<number, string>, remark?: string, signs?: Map<number, string[]>) => {
  const spellers = new Map(sheet.keys.map((k) => [k.bar, speller(k.tonic, sheet.mode)]))
  let s = spellers.get(0) ?? speller(sheet.tonic, sheet.mode)
  const total = sheet.bars * BAR
  const list = onsets(events)
  const octaves = style.clef === 'treble' && !style.drum ? ottava(list) : []
  const bars: string[][] = Array.from({ length: sheet.bars }, () => [])
  const prefixes = new Map<number, string[]>()
  const prefix = (pos: number, text: string) => prefixes.set(pos, [...(prefixes.get(pos) ?? []), text])
  if (remark) prefix(0, `"^${remark.replaceAll('%', '\\%')}"`)
  if (top) for (const section of sheet.labels) prefix(section.bar * BAR, `"^${section.label}"`)
  for (const [pos, mark] of octaves) prefix(pos, mark)
  for (const [pos, list] of signs ?? []) for (const text of list) prefix(pos, text)
  let dynamic = ''
  for (let bar = 0; bar < sheet.bars && !style.inner; bar++) {
    const inBar = list.filter((o) => Math.floor(o.pos / BAR) === bar)
    if (!inBar.length) continue
    const mark = nearestDynamic(median(inBar.flatMap((o) => o.levels)))
    if (mark !== dynamic && said.get(bar) !== mark) prefix(inBar[0].pos, `!${mark}!`)
    if (mark !== dynamic) said.set(bar, mark)
    dynamic = mark
  }
  const pieces: { pos: number; len: number; midis: number[] | null; tie: boolean; arpeggio: boolean; accent: boolean }[] = []
  const push = (pos: number, len: number, midis: number[] | null, arpeggio = false, accent = false) => {
    let at = pos
    while (at < pos + len) {
      const start = Math.floor(at / BAR) * BAR
      const span = Math.min(pos + len, start + BAR) - at
      for (const l of split(at - start, span, midis ? NOTE_LENGTHS : REST_LENGTHS)) {
        pieces.push({ pos: at, len: l, midis, tie: midis !== null && at + l < pos + len, arpeggio: arpeggio && at === pos, accent: accent && at === pos })
        at += l
      }
    }
  }
  let t = 0
  list.forEach((o, i) => {
    if (o.pos >= total) return
    if (o.pos > t) push(t, o.pos - t, null)
    const barEnd = (Math.floor(o.pos / BAR) + 1) * BAR
    let end = Math.min(o.end, list[i + 1]?.pos ?? total, total)
    // A spill of less than an eighth past the barline is a legato overlap in the source, not a written tie.
    if (end > barEnd && end % BAR < 2) end -= end % BAR
    if (style.rings) end = o.pos + split(o.pos % BAR, Math.min(end, barEnd) - o.pos, NOTE_LENGTHS)[0]
    push(o.pos, end - o.pos, [...o.midis].map((m) => m - o.shift).sort((a, b) => a - b), o.arpeggio && o.midis.size > 1, o.accent)
    t = end
  })
  if (t < total) push(t, total - t, null)
  let accidentals = s.bar()
  let current = -1
  let last: { beat: number; beamable: boolean } | null = null
  for (const p of pieces) {
    const bar = Math.floor(p.pos / BAR)
    if (bar !== current) {
      const key = sheet.keys.find((k) => k.bar === bar && bar > 0)
      // abcjs crashes on an inline key in the second voice of a staff, which follows the staff's key anyway; and without a clef the key resets the staff to treble.
      if (key && !style.inner && !style.drum) bars[bar].push(`[K:${keyName(key.tonic, sheet.mode)} clef=${style.clef}]`)
      s = spellers.get(bar) ?? s
      accidentals = s.bar()
      current = bar
      last = null
    }
    const len = p.len === 1 ? '' : String(p.len)
    const marks = [...(prefixes.get(p.pos) ?? [])].filter((m) => p.midis || m.startsWith('"') || m === '!fermata!')
    prefixes.delete(p.pos)
    if (p.midis && p.accent) marks.push('!>!')
    if (p.midis && p.arpeggio) marks.push('!arpeggio!')
    const names = p.midis?.map((m) => {
      if (!style.drum) return s.note(m, accidentals)
      const pos = DRUM_POSITIONS[m]
      if (pos === undefined) throw new Error(`no staff position for drum ${m}; add it to DRUMS`)
      return abcPitch(pos)
    })
    const body = !names ? `${style.inner ? 'x' : 'z'}${len}` : names.length === 1 ? `${names[0]}${len}` : `[${names.join('')}]${len}`
    const token = { beat: Math.floor(p.pos / BEAT), beamable: p.midis !== null && p.len < BEAT }
    const glue = last && last.beamable && token.beamable && last.beat === token.beat ? '' : ' '
    bars[bar].push((bars[bar].length ? glue : '') + marks.join('') + body + (p.tie ? '-' : ''))
    last = token
  }
  return bars.map((tokens) => tokens.join(''))
}
