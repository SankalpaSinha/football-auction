import { describe, expect, it, vi } from 'vitest';
import { autoPick, buildMatchReport } from '@fa/shared';
import { ClaudeCommentator, commentatorFromEnv, type Commentator, type CommentaryInput } from '../src/services/commentary';
import { completeAuction, createHarness } from './helpers';

function finishGame(commentator?: Commentator) {
  const h = createHarness({ players: 3, commentator });
  completeAuction(h);
  for (const u of h.users) {
    const squad = h.member(u.id).squad.map((e) => e.player);
    h.room.lockLineup(u.id, { formationId: '4-3-3', slots: autoPick(squad, '4-3-3') });
  }
  h.clock.advance(h.room.view('u1').resultsAt! - h.clock.now());
  return h;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('match report', () => {
  it('is deterministic and names the winner', () => {
    const h = finishGame();
    const r = h.room.view('u1').results!;
    const winner = h.room.view('u1').members.find((m) => m.userId === r.rankings[0].userId)!;
    expect(r.report.headline).toContain(winner.username);
    expect(r.report.headline).toContain(r.rankings[0].total.toFixed(1));
    expect(r.report.summary.length).toBeGreaterThan(40);
    const managers = h.room.view('u1').members.map((m) => ({ userId: m.userId, username: m.username, squad: m.squad }));
    expect(buildMatchReport(r.rankings, managers)).toEqual(r.report);
  });

  it('hands out room awards and a verdict for every manager', () => {
    const h = finishGame();
    const r = h.room.view('u1').results!;
    const keys = r.report.awards.map((a) => a.key);
    for (const k of ['record', 'star', 'chemistry', 'tactics', 'depth', 'thrift']) expect(keys).toContain(k);
    for (const m of h.users) expect(r.report.verdicts[m.id]).toBeTruthy();
  });
});

describe('AI commentary (optional)', () => {
  it('is disabled by default and results do not depend on it', () => {
    const h = finishGame();
    expect(h.room.view('u1').results!.commentary).toEqual({ status: 'disabled', text: null });
  });

  it('shows pending, then the text, without delaying results', async () => {
    let resolve!: (s: string) => void;
    const c: Commentator = { enabled: true, generate: () => new Promise((r) => (resolve = r)) };
    const h = finishGame(c);
    expect(h.room.phase).toBe('RESULTS');
    expect(h.room.view('u1').results!.commentary.status).toBe('pending');
    const before = h.room.view('u1').results!.rankings;
    resolve('What a finish!');
    await flush();
    const after = h.room.view('u1').results!;
    expect(after.commentary).toEqual({ status: 'ready', text: 'What a finish!' });
    expect(after.rankings).toEqual(before); // AI never changes the result
  });

  it('degrades quietly when the commentator fails', async () => {
    const c: Commentator = { enabled: true, generate: () => Promise.reject(new Error('boom')) };
    const h = finishGame(c);
    await flush();
    expect(h.room.view('u1').results!.commentary.status).toBe('unavailable');
  });

  it('is only enabled when an API key is configured', () => {
    expect(commentatorFromEnv({}).enabled).toBe(false);
    expect(commentatorFromEnv({ ANTHROPIC_API_KEY: 'x', AI_COMMENTARY: 'off' }).enabled).toBe(false);
    expect(commentatorFromEnv({ ANTHROPIC_API_KEY: 'x' }).enabled).toBe(true);
  });

  it('sends results as data and treats refusals as no commentary', async () => {
    const input: CommentaryInput = {
      competition: 'Premier League 2026–27',
      rankings: [],
      usernames: {},
      playerNames: {},
      formations: {},
      report: { headline: 'A wins', summary: '', awards: [], verdicts: {} },
    };
    const create = vi
      .fn()
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' Great game. ' }] })
      .mockResolvedValueOnce({ stop_reason: 'refusal', content: [] });
    const fake = { beta: { messages: { create } } } as never;
    const c = new ClaudeCommentator(fake, () => {});
    expect(await c.generate(input)).toBe('Great game.');
    expect(await c.generate(input)).toBeNull();
    const params = create.mock.calls[0][0];
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toContain('server-side-fallback-2026-07-01');
    expect(JSON.parse(params.messages[0].content).headline).toBe('A wins');
  });
});

describe('report wording', () => {
  it('keeps player names capitalised mid-sentence', async () => {
    const { buildMatchReport } = await import('@fa/shared');
    const base = { breakdown: { quality: 70, positionFit: 80, tactics: 80, synergy: 50, chemistry: 60, balance: 90, depth: 60, efficiency: 90 }, lines: { gk: 80, def: 80, mid: 80, att: 80 }, tactics: [], tacticId: 'BALANCED' as const, styleMatch: { liked: 0, of: 11 }, synergies: [], objectives: [], objectiveBonus: 0, links: [], bestPlayerId: null, bestBuy: null, worstBuy: null, spent: 100 };
    const report = buildMatchReport(
      [
        { ...base, userId: 'a', rank: 1, total: 80, notes: [{ kind: 'weakness', text: 'Baleba is out of position at ST' }] },
        { ...base, userId: 'b', rank: 2, total: 70, notes: [{ kind: 'weakness', text: 'Thin squad: only 1 goalkeeper option' }] },
      ],
      [
        { userId: 'a', username: 'A', squad: [] },
        { userId: 'b', username: 'B', squad: [] },
      ],
    );
    expect(report.summary).toContain('Baleba is out of position');
    expect(report.verdicts.b).toContain('weak spot: thin squad');
  });
});
