import type { Metadata, Viewport } from 'next';
import { Barlow_Condensed, Inter, JetBrains_Mono } from 'next/font/google';
import { Credit } from '@/components/Credit';
import { Providers } from '@/components/Providers';
import './globals.css';

const barlow = Barlow_Condensed({ subsets: ['latin', 'latin-ext'], weight: ['500', '600', '700', '800'], variable: '--font-barlow' });
const inter = Inter({ subsets: ['latin', 'latin-ext'], variable: '--font-inter' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['500', '700'], variable: '--font-jetbrains' });

export const metadata: Metadata = {
  title: 'Football Auction',
  description: 'Live multiplayer football auction — bid, build your 18, outsmart your friends.',
  appleWebApp: { capable: true, title: 'Football Auction', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = { themeColor: '#05070d', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${barlow.variable} ${inter.variable} ${mono.variable}`}>
      <body>
        <Providers>
          {children}
          <Credit />
        </Providers>
      </body>
    </html>
  );
}
