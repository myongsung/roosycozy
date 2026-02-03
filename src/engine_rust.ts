// src/engine_rust.ts
import { invoke } from '@tauri-apps/api/core';
import type { CaseItem, RecordItem, AdvisorItem } from './engine';

export async function rustRankRecordsForCase(
  records: RecordItem[],
  caseItem: CaseItem,
  opts?: {
    limit?: number; // 최대 결과 개수
    weights?: { actor?: number; related?: number; text?: number; time?: number };
    minScore?: number;
    minTextSim?: number; // 0~1, query 토큰 부분일치 비율
  }
): Promise<Array<{ id: string; score: number }>> {
  return invoke('engine_rank', {
    records,
    caseItem,
    opts: opts
      ? {
          maxResults: opts.limit,
          weights: opts.weights,
          minScore: opts.minScore,
          minTextSim: opts.minTextSim
        }
      : undefined
  });
}

export async function rustGenerateAdvisorsForCase(
  records: RecordItem[],
  caseItem: CaseItem
): Promise<AdvisorItem[]> {
  return invoke('engine_advise', { records, caseItem });
}
