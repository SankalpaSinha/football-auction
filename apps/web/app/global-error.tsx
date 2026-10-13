'use client';

/** Last-resort boundary (errors in the root layout itself). */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: '#05070d', color: '#e8ecf4', fontFamily: 'system-ui', display: 'grid', placeItems: 'center', minHeight: '100dvh' }}>
        <div style={{ textAlign: 'center' }}>
          <h1>Something went wrong</h1>
          <button onClick={reset} style={{ marginTop: 16, padding: '10px 20px', borderRadius: 12, border: 0, background: '#c8ff2e', fontWeight: 700 }}>
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
