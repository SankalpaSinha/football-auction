import type { MetadataRoute } from 'next';

/** Lets players "Add to Home Screen" and launch the game full-screen like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Football Auction',
    short_name: 'Auction',
    description: 'Live multiplayer football auction — bid, build your 18, outsmart your friends.',
    start_url: '/',
    display: 'standalone',
    background_color: '#05070d',
    theme_color: '#05070d',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}
