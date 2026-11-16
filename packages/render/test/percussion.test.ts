import { checkScore, render } from 'plainscore'
import { BasicSoundBank, SpessaSynthProcessor } from 'spessasynth_core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStems } from '../src/stems.ts'

const rate = 48000
const text = `score 0.3
instruments
  piano  piano
  kit    drums
piece t  T
  tempo  q = 120
  key    C major
  chords c
    C  C3 | E4 G4 C5
  part tune  piano mf lead
    | C5 h r h |
  part beat  kit  mf
    | kick h r h |
  form
    A  c
      tune, beat
`

const energy = (x: Float32Array, from: number, to: number) => {
  let s = 0
  for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) s += x[i] * x[i]
  return s
}

const sine = (freq: number, seconds: number) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * freq * i) / rate))

afterEach(() => vi.restoreAllMocks())

describe('the percussion channel', () => {
  it('plays the kit on MIDI channel 9, without a program change', async () => {
    await BasicSoundBank.ready
    const bank = BasicSoundBank.getSampleSoundBankFile()
    const r = render(checkScore(text, 't.score'), 't')
    const hits = new Set(r.events.filter((e) => e.inst === 'kit').map((e) => e.midi))
    expect(hits.size).toBeGreaterThan(0)
    const on = vi.spyOn(SpessaSynthProcessor.prototype, 'noteOn')
    const program = vi.spyOn(SpessaSynthProcessor.prototype, 'programChange')
    await renderStems(r, { piano: { soundfont: bank, preset: 0 }, kit: { soundfont: bank, preset: 0 } }, rate)
    const notes = on.mock.calls.map(([channel, midi]) => ({ channel, midi }))
    expect(notes.filter((n) => hits.has(n.midi)).map((n) => n.channel)).toEqual([9])
    expect(notes.filter((n) => !hits.has(n.midi)).map((n) => n.channel)).toEqual([0])
    expect(program.mock.calls.map(([channel]) => channel)).toEqual([0])
  })

  it('leaves a kit that is a sample set on the sampler', async () => {
    const source = { samples: [sine(440, 2)], rate, sprite: { C5: [0, 2] as [number, number] }, attack: 0, release: 0.1 }
    const r = render(checkScore(text, 't.score'), 't')
    const on = vi.spyOn(SpessaSynthProcessor.prototype, 'noteOn')
    const { stems } = await renderStems(r, { piano: source, kit: source }, rate)
    expect(on).not.toHaveBeenCalled()
    expect(energy(stems.find((s) => s.target === 'kit')!.channels[0], 0, 0.4)).toBeGreaterThan(0.1)
  })
})
