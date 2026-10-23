import { describe, expect, it } from 'vitest';
import { bestByKeywords, keywordScore } from './keywords.js';

describe('keywordScore', () => {
  it('scores the share of job words found in the resume', () => {
    expect(keywordScore('voice TTS dubbing', 'Built TTS and dubbing pipelines')).toBeCloseTo(2 / 3);
    expect(keywordScore('', 'anything')).toBe(0);
  });
});

describe('bestByKeywords', () => {
  it('picks the resume sharing the most words with the job', () => {
    const resumes = [
      { name: 'Full-stack', text: 'React Next.js Node.js Postgres dashboards' },
      { name: 'Voice AI', text: 'TTS ASR voice cloning dubbing ElevenLabs' },
    ];
    const r = bestByKeywords('Voice AI Engineer: TTS, ASR and voice cloning', resumes);
    expect(r.index).toBe(1);
    expect(r.matched).toContain('tts');
  });
});
