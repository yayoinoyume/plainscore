import { describe, expect, it } from 'vitest'
import { toAbc } from '../src/abc/index.ts'
import { checkScore } from '../src/expand.ts'
import { FAMILIES } from '../src/families.ts'
import { toMidi } from '../src/midi.ts'
import { parseScore } from '../src/parse.ts'
import { render } from '../src/render.ts'
import { layout } from '../src/staves.ts'
import { DRUMS } from '../src/words.ts'

const text = `score 0.2
title  Band
instruments
  piano   piano
  gtr     guitar
  egtr    electric
  lead    distortion
  kit     drums

piece band  Band
  tempo  q = 96
  key    A minor

  chords loop
    Am  A2 | A3 C4 E4
    F   F2 | F3 A3 C4

  part keys  piano  mp
    1  bass  w

  part strum  gtr  mf
    1  chord  w  roll 20ms

  part solo  egtr  f  lead
    | A4 e C5 e E5 e A5 e G5 e E5 e C5 e A4 e |

  part wall  lead  f
    | A3 w |

  part beat  kit  mf
    | kick e r e snare e r e kick e r e snare e r e |
    | kick e r e snare e r e kick e r e snare e r e |

  form
    A  loop
      keys, strum, solo, wall, beat
`

const score = parseScore(text, 'band.score')
const rendering = render(score, 'band')

const tracks = (midi: Uint8Array) => {
  const bytes = Buffer.from(midi)
  const out: { channels: Set<number>; programs: number[][]; pitches: Set<number> }[] = []
  for (let i = 14; i < bytes.length; ) {
    const len = bytes.readUInt32BE(i + 4)
    const t = bytes.subarray(i, i + 8 + len)
    const channels = new Set<number>()
    const programs: number[][] = []
    const pitches = new Set<number>()
    for (let k = 0; k < t.length; k++) {
      const status = t[k] & 0xf0
      if (status === 0x90) {
        channels.add(t[k] & 0x0f)
        if (t[k + 2] > 0) pitches.add(t[k + 1])
      } else if (status === 0xc0) programs.push([t[k] & 0x0f, t[k + 1]])
    }
    out.push({ channels, programs, pitches })
    i += 8 + len
  }
  return out
}

describe('the guitar families', () => {
  it('carries a program per guitar', () => {
    expect(FAMILIES.guitar.program).toBe(25)
    expect(FAMILIES.electric.program).toBe(27)
    expect(FAMILIES.distortion.program).toBe(30)
  })

  it('rings like a plucked string, without a pedal', () => {
    for (const family of ['guitar', 'electric', 'distortion'])
      expect(FAMILIES[family]).toMatchObject({ clef: 'treble', grand: false, pedal: false, rings: true })
  })

  it('writes the program into the MIDI track', () => {
    const programs = tracks(toMidi(rendering)).flatMap((t) => t.programs).map(([, p]) => p)
    expect(programs).toEqual(expect.arrayContaining([25, 27, 30]))
  })
})

describe('the drums family', () => {
  it('is a percussion clef and takes no program', () => {
    expect(FAMILIES.drums.clef).toBe('perc')
    expect(layout(rendering).staves.find((s) => s.id === 'kit')!.clef).toBe('perc')
  })

  it('takes drum words for pitches and keeps them off the key', () => {
    const kit = rendering.events.filter((e) => e.part === 'beat').map((e) => e.midi)
    expect(new Set(kit)).toEqual(new Set([DRUMS.kick, DRUMS.snare]))
  })

  it('sends the kit to the percussion channel with no program change', () => {
    const kit = tracks(toMidi(rendering)).find((t) => t.channels.has(9))!
    expect(kit.channels).toEqual(new Set([9]))
    expect(kit.programs).toEqual([])
    expect(kit.pitches).toEqual(new Set([DRUMS.kick, DRUMS.snare]))
  })

  it('engraves drum hits as legal ABC with a percmap per staff position', () => {
    const abc = toAbc(rendering)
    expect(abc).toContain('V:kit clef=perc name="Kit"')
    // abcjs keys a percussion note by x + verticalPos, and a digit after a note is its length, not its octave.
    expect(abc).toContain(`%%percmap x1 ${DRUMS.kick} x`)
    expect(abc).toContain(`%%percmap x3 ${DRUMS.snare} x`)
    const kit = abc.split('\n').filter((line) => line.startsWith('[V:kit]')).join('\n')
    expect(kit).not.toMatch(/\b(kick|snare)\b/)
    for (const note of kit.match(/[A-Ga-g][,']*\d*/g) ?? []) {
      const letters = note.replace(/\d+$/, '')
      expect(letters).toMatch(/^[A-G]$|^[a-g]['`']*$/)
      expect(Number(note.slice(letters.length) || 1)).toBeLessThanOrEqual(16)
    }
  })

  it('takes a drum cue and refuses a pedal', () => {
    const cue = text.replace('  part beat  kit  mf\n    | kick e r e snare e r e kick e r e snare e r e |\n    | kick e r e snare e r e kick e r e snare e r e |', '  part beat  kit  mf\n    1  kick  q\n    3  snare  q')
    const played = render(checkScore(cue, 'band.score'), 'band')
    expect(new Set(played.events.filter((e) => e.part === 'beat').map((e) => e.midi))).toEqual(new Set([DRUMS.kick, DRUMS.snare]))
    expect(() => checkScore(text.replace('  part beat  kit  mf', '  part beat  kit  mf\n    1  Ped.'), 'band.score')).toThrow(/drums part takes no pedal/)
  })

  it('keeps drum hits off the key in a transposed section', () => {
    const moved = render(checkScore(text.replace('    A  loop\n', '    A  loop in E\n'), 'band.score'), 'band')
    expect(new Set(moved.events.filter((e) => e.part === 'beat').map((e) => e.midi))).toEqual(new Set([DRUMS.kick, DRUMS.snare]))
  })

  it('refuses a drum word on a pitched part', () => {
    expect(() => checkScore(text.replace('1  bass  w', '1  kick  w'), 'band.score')).toThrow(/kick.*is a drum/)
  })

  it('refuses a pitch on a drums part', () => {
    expect(() => checkScore(text.replace('| kick e r e snare e r e kick e r e snare e r e |', '| kick e r e C4 e r e kick e r e snare e r e |'), 'band.score')).toThrow(/C4.*is not a drum/)
  })
})
