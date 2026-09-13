/**
 * Audio formats a slot will accept, in preference order.
 *
 * Opus first because it is the smallest at equal quality and payload budgets
 * are always tight, but nothing requires it: whatever format a sound was made
 * in can be dropped straight in. Every one of these decodes natively in the
 * browsers a WebGL2 game already requires, so demanding a transcode would buy
 * nothing and cost the person making the sound a round trip every time they
 * wanted to hear it in context.
 */
export const AUDIO_FORMATS = ['opus', 'mp3', 'ogg', 'm4a', 'wav'] as const;

export type AudioFormat = (typeof AUDIO_FORMATS)[number];

/**
 * Every filename a named slot answers to. Feed the result to
 * `SoundSource.urls`, which tries them in order and takes the first that
 * loads.
 */
export function audioCandidateUrls(name: string, baseDir = '/audio'): string[] {
  return AUDIO_FORMATS.map((ext) => `${baseDir}/${name}.${ext}`);
}
