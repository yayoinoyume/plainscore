import { BasicSoundBank, SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core'
import type { SoundfontSource } from './types.ts'

const BLOCK = 128
const PERCUSSION = 9
const banks = new WeakMap<ArrayBuffer, BasicSoundBank>()

export const loadBank = async (buffer: ArrayBuffer) => {
  await BasicSoundBank.ready
  let bank = banks.get(buffer)
  if (!bank) {
    bank = SoundBankLoader.fromArrayBuffer(buffer)
    banks.set(buffer, bank)
  }
  return bank
}

export interface SynthMessage {
  time: number
  order: number
  kind: 'on' | 'off' | 'pedal'
  midi: number
  value: number
}

export const playSoundfont = async (source: SoundfontSource, program: number, messages: SynthMessage[], out: Float32Array[], rate: number, drums = false) => {
  const bank = await loadBank(source.soundfont)
  const synth = new SpessaSynthProcessor(rate, { effectsEnabled: false, eventsEnabled: false })
  synth.soundBankManager.addSoundBank(bank, 'main')
  // MIDI channel 9 is the kit; a bank or program change there would move it off the GM drums.
  const channel = drums ? PERCUSSION : 0
  if (!drums) {
    if (source.bank) synth.controllerChange(0, 0, source.bank)
    synth.programChange(0, source.preset ?? program)
  }
  const sorted = [...messages].sort((a, b) => a.time - b.time || a.order - b.order)
  const frames = out[0].length
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  let at = 0
  let i = 0
  while (at < frames) {
    while (i < sorted.length && Math.round(sorted[i].time * rate) <= at) {
      const m = sorted[i++]
      if (m.kind === 'on') synth.noteOn(channel, m.midi, m.value)
      else if (m.kind === 'off') synth.noteOff(channel, m.midi)
      else synth.controllerChange(channel, 64, m.value)
    }
    const next = i < sorted.length ? Math.round(sorted[i].time * rate) : frames
    const n = Math.min(BLOCK, frames - at, Math.max(1, next - at))
    synth.process(left, right, at, n)
    at += n
  }
  for (let k = 0; k < frames; k++) {
    out[0][k] += left[k]
    out[1][k] += right[k]
  }
}

export const bankCredit = async (buffer: ArrayBuffer) => {
  const info = (await loadBank(buffer)).soundBankInfo as unknown as Record<string, unknown>
  return ['name', 'copyright', 'engineer', 'comment']
    .map((k) => info[k])
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(' — ')
}
