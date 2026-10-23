// Rough "which resume fits this job" score from shared words: the fallback
// when Gemini can't answer, and what the test fake uses.

const STOP = new Set(
  'a an and are as at be by for from has have in is it its of on or our that the their this to we will with you your using use work working build building experience years role team strong'.split(' '),
);

export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9+#.\s-]/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

// Share of the job's words that appear in the resume (0..1).
export function keywordScore(job: string, resume: string): number {
  const want = words(job);
  if (!want.size) return 0;
  const have = words(resume);
  let hit = 0;
  for (const w of want) if (have.has(w)) hit++;
  return hit / want.size;
}

// Index of the best resume for the job, and the job words it matched.
export function bestByKeywords(job: string, resumes: { name: string; text: string }[]): { index: number; matched: string[] } {
  const scores = resumes.map((r) => keywordScore(job, `${r.name} ${r.text}`));
  const index = scores.indexOf(Math.max(...scores));
  const have = words(`${resumes[index].name} ${resumes[index].text}`);
  return { index, matched: [...words(job)].filter((w) => have.has(w)).slice(0, 4) };
}
