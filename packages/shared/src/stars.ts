import type { PlayerCard } from './types';

/**
 * Real-world superstars: the household names everyone wants (not simply
 * "rated 85+"). A squad may hold at most `rules.starCap.max` of them.
 * Ids are the stable player ids from data/seed/<season>/players.csv.
 */
export const STAR_PLAYER_IDS: ReadonlySet<string> = new Set([
  // forwards
  'cristiano-ronaldo',
  'lionel-messi',
  'kylian-mbappe',
  'lamine-yamal',
  'erling-haaland',
  'harry-kane',
  'ousmane-dembele',
  'vinicius-junior',
  'mohamed-salah',
  'raphinha',
  'lautaro-martinez',
  'bukayo-saka',
  'michael-olise',
  'khvicha-kvaratskhelia',
  // midfielders
  'jude-bellingham',
  'kevin-de-bruyne',
  'luka-modric',
  'rodri',
  'pedri',
  'jamal-musiala',
  'florian-wirtz',
  'cole-palmer',
  'federico-valverde',
  'joshua-kimmich',
  'bruno-fernandes',
  'martin-odegaard',
  'declan-rice',
  // defenders and keepers
  'virgil-van-dijk',
  'achraf-hakimi',
  'william-saliba',
  'thibaut-courtois',
  'alisson',
  'gianluigi-donnarumma',
]);

/** Whether a player counts towards the star limit. */
export function isStarPlayer(p: Pick<PlayerCard, 'playerId'> & { star?: boolean }): boolean {
  return p.star ?? STAR_PLAYER_IDS.has(p.playerId);
}
