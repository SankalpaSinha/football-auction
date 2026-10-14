import { careerAchievements, ELO_CONFIG, FORMATIONS, type EloChange, type GameMode, type RankedScore } from '@fa/shared';
import type { GameStore } from '../engine/store';
import type { Db } from '../lib/db';

/** Writes rooms, games, lots, bids and squads to PostgreSQL. */
export class PrismaGameStore implements GameStore {
  /** gameId → auction row id */
  private auctionIds = new Map<string, string>();

  constructor(private readonly db: Db) {}

  /** Keep the Formation table in sync with the code-defined formations. */
  async ensureFormations() {
    for (const f of FORMATIONS) {
      await this.db.formation.upsert({
        where: { id: f.id },
        create: { id: f.id, name: f.name, slots: f.slots as object },
        update: { name: f.name, slots: f.slots as object },
      });
    }
  }

  async lineupsFinalized(gameId: string, lineups: { userId: string; formationId: string; slots: string[] }[]) {
    await this.db.$transaction(async (tx) => {
      for (const l of lineups) {
        const squad = await tx.squad.update({
          where: { gameId_userId: { gameId, userId: l.userId } },
          data: { formationId: l.formationId },
        });
        await tx.squadPlayer.updateMany({ where: { squadId: squad.id }, data: { role: 'BENCH', slotIndex: null } });
        for (const [slotIndex, playerStatsId] of l.slots.entries()) {
          await tx.squadPlayer.updateMany({
            where: { squadId: squad.id, playerStatsId },
            data: { role: 'STARTER', slotIndex },
          });
        }
      }
    });
  }

  async roomCreated(r: Parameters<GameStore['roomCreated']>[0]) {
    await this.db.room.create({
      data: {
        id: r.id,
        code: r.code,
        name: r.name,
        hostUserId: r.hostUserId,
        competitionId: r.settings.competitionId,
        seasonId: r.settings.seasonId,
        settings: r.settings as object,
        mode: r.settings.mode,
        isPublic: r.settings.isPublic,
      },
    });
  }

  async memberJoined(roomId: string, userId: string, seat: number) {
    await this.db.roomPlayer.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: { roomId, userId, seat },
      update: { seat, leftAt: null },
    });
  }

  async memberLeft(roomId: string, userId: string) {
    await this.db.roomPlayer.updateMany({ where: { roomId, userId }, data: { leftAt: new Date() } });
  }

  async hostChanged(roomId: string, hostUserId: string) {
    await this.db.room.update({ where: { id: roomId }, data: { hostUserId } });
  }

  async gameStarted(g: Parameters<GameStore['gameStarted']>[0]) {
    const auction = await this.db.$transaction(async (tx) => {
      await tx.room.update({ where: { id: g.roomId }, data: { status: 'IN_GAME' } });
      await tx.game.create({ data: { id: g.gameId, roomId: g.roomId, seed: g.seed, mode: g.mode } });
      await tx.squad.createMany({
        data: g.participants.map((p) => ({
          gameId: g.gameId,
          userId: p.userId,
          budgetStart: p.budget,
          budgetRemaining: p.budget,
        })),
      });
      return tx.auction.create({
        data: {
          gameId: g.gameId,
          orderStrategy: g.orderStrategy,
          poolSize: g.poolSize,
          config: g.config as object,
        },
      });
    });
    this.auctionIds.set(g.gameId, auction.id);
  }

  async lotClosed(gameId: string, lot: Parameters<GameStore['lotClosed']>[1], participants: Parameters<GameStore['lotClosed']>[2]) {
    const auctionId = this.auctionIds.get(gameId);
    if (!auctionId) throw new Error(`no auction row for game ${gameId}`);
    await this.db.$transaction(async (tx) => {
      const row = await tx.auctionLot.create({
        data: {
          auctionId,
          lotNumber: lot.lotNumber,
          playerStatsId: lot.player.id,
          outcome: lot.outcome,
          winnerUserId: lot.winnerId,
          price: lot.price,
          estimatedValue: lot.estimatedValue,
          openedAt: lot.openedAt ? new Date(lot.openedAt) : null,
          closedAt: new Date(lot.closedAt),
        },
      });
      if (lot.bids.length) {
        await tx.bid.createMany({
          data: lot.bids.map((b) => ({ lotId: row.id, userId: b.userId, amount: b.amount, createdAt: new Date(b.at) })),
        });
      }
      if (lot.winnerId && lot.price !== null) {
        const winner = participants.find((p) => p.userId === lot.winnerId)!;
        const squad = await tx.squad.update({
          where: { gameId_userId: { gameId, userId: lot.winnerId } },
          data: { budgetRemaining: winner.budget },
        });
        await tx.squadPlayer.create({
          data: {
            squadId: squad.id,
            gameId,
            playerStatsId: lot.player.id,
            price: lot.price,
            acquiredVia: lot.outcome === 'AUTO_ASSIGNED' ? 'AUTO' : lot.outcome === 'PICKED' ? 'PICK' : 'AUCTION',
            lotNumber: lot.lotNumber,
          },
        });
      }
    });
  }

  async auctionCompleted(gameId: string) {
    await this.db.game.update({ where: { id: gameId }, data: { status: 'SQUAD_BUILDING' } });
  }

  async participantRemoved(gameId: string, userId: string) {
    await this.db.$transaction(async (tx) => {
      const squad = await tx.squad.findUnique({ where: { gameId_userId: { gameId, userId } } });
      if (!squad) return;
      await tx.squadPlayer.deleteMany({ where: { squadId: squad.id } });
      await tx.squad.delete({ where: { id: squad.id } });
    });
  }

  async playerReleased(gameId: string, _userId: string, playerId: string) {
    await this.db.squadPlayer.deleteMany({ where: { gameId, playerStatsId: playerId } });
  }

  async tradeCompleted(
    gameId: string,
    moves: { playerId: string; toUserId: string; price: number }[],
    budgets: { userId: string; budget: number }[],
  ) {
    await this.db.$transaction(async (tx) => {
      for (const m of moves) {
        const squad = await tx.squad.findUniqueOrThrow({ where: { gameId_userId: { gameId, userId: m.toUserId } } });
        await tx.squadPlayer.update({
          where: { gameId_playerStatsId: { gameId, playerStatsId: m.playerId } },
          data: { squadId: squad.id, price: m.price, acquiredVia: 'TRADE' },
        });
      }
      for (const b of budgets) {
        await tx.squad.update({ where: { gameId_userId: { gameId, userId: b.userId } }, data: { budgetRemaining: b.budget } });
      }
    });
  }

    async ratingsFor(userIds: string[], mode: GameMode) {
    const rows = await this.db.playerRating.findMany({ where: { userId: { in: userIds }, mode } });
    return Object.fromEntries(
      userIds.map((id) => {
        const r = rows.find((x) => x.userId === id);
        return [id, { elo: r?.elo ?? ELO_CONFIG.initial, games: r?.games ?? 0 }];
      }),
    );
  }

  async gameFinished(
    gameId: string,
    rankings: RankedScore[],
    ratingChanges: EloChange[] | null,
    achievements: Record<string, string[]>,
  ) {
    await this.db.$transaction(async (tx) => {
      const game = await tx.game.update({ where: { id: gameId }, data: { status: 'FINISHED', endedAt: new Date() } });
      await tx.room.update({ where: { id: game.roomId }, data: { status: 'FINISHED' } });
      for (const r of rankings) {
        const { userId, rank, total, ...detail } = r;
        // Apply the ELO *change* to the rating as it is now (another game may have
        // finished since this one started) instead of overwriting it with a snapshot.
        const change = ratingChanges?.find((c) => c.userId === userId);
        const current = change
          ? await tx.playerRating.findUnique({ where: { userId_mode: { userId, mode: 'RANKED' } } })
          : null;
        const before = current?.elo ?? ELO_CONFIG.initial;
        const elo = change ? { before, after: Math.max(ELO_CONFIG.floor, before + change.delta) } : null;
        const eloFields = elo ? { eloBefore: elo.before, eloAfter: elo.after } : {};
        await tx.matchResult.upsert({
          where: { gameId_userId: { gameId, userId } },
          create: { gameId, userId, rank, score: total, breakdown: detail as object, ...eloFields },
          update: { rank, score: total, breakdown: detail as object, ...eloFields },
        });
        // Every finished game counts towards profile stats; ELO only moves in ranked games.
        const existing = await tx.playerRating.findUnique({ where: { userId_mode: { userId, mode: game.mode } } });
        await tx.playerRating.upsert({
          where: { userId_mode: { userId, mode: game.mode } },
          create: {
            userId,
            mode: game.mode,
            games: 1,
            wins: rank === 1 ? 1 : 0,
            podiums: rank <= 3 ? 1 : 0,
            totalScore: total,
            highestScore: total,
            ...(elo ? { elo: elo.after } : {}),
          },
          update: {
            games: { increment: 1 },
            wins: { increment: rank === 1 ? 1 : 0 },
            podiums: { increment: rank <= 3 ? 1 : 0 },
            totalScore: { increment: total },
            highestScore: Math.max(existing?.highestScore ?? 0, total),
            ...(elo ? { elo: elo.after } : {}),
          },
        });

        // Achievements: this game's, plus career ones from the updated totals. Each unlocks once.
        const totals = await tx.playerRating.findMany({ where: { userId } });
        const career = careerAchievements({
          games: totals.reduce((a, t) => a + t.games, 0),
          wins: totals.reduce((a, t) => a + t.wins, 0),
          rankedElo: totals.find((t) => t.mode === 'RANKED')?.elo ?? 0,
        });
        await tx.userAchievement.createMany({
          data: [
            ...(achievements[userId] ?? []).map((key) => ({ userId, key, gameId })),
            ...career.map((key) => ({ userId, key, gameId })),
          ],
          skipDuplicates: true,
        });
      }

      // Managers removed for inactivity in a ranked game take a last-place rating loss.
      const ranked = new Set(rankings.map((r) => r.userId));
      for (const c of ratingChanges ?? []) {
        if (ranked.has(c.userId)) continue;
        const current = await tx.playerRating.findUnique({ where: { userId_mode: { userId: c.userId, mode: 'RANKED' } } });
        const elo = Math.max(ELO_CONFIG.floor, (current?.elo ?? ELO_CONFIG.initial) + c.delta);
        await tx.playerRating.upsert({
          where: { userId_mode: { userId: c.userId, mode: 'RANKED' } },
          create: { userId: c.userId, mode: 'RANKED', games: 1, elo },
          update: { games: { increment: 1 }, elo },
        });
      }
    });
  }

  async roomClosed(roomId: string, status: 'FINISHED' | 'ABANDONED' | 'CLOSED', gameId: string | null) {
    await this.db.room.update({ where: { id: roomId }, data: { status, closedAt: new Date() } });
    if (gameId && status === 'ABANDONED') {
      await this.db.game.update({ where: { id: gameId }, data: { status: 'ABANDONED', endedAt: new Date() } });
    }
    if (gameId) this.auctionIds.delete(gameId);
  }
}
