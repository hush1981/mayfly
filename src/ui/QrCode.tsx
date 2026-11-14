/** QR code rendered with plain Views (dark runs per row merged), no SVG dependency. */
import React, { useMemo } from 'react';
import { View } from 'react-native';
import qrcode from 'qrcode-generator';

export default function QrCode({ value, size = 220 }: { value: string; size?: number }) {
  const rows = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const out: { n: number; runs: [number, number][] } = { n, runs: [] };
    const all: [number, number][][] = [];
    for (let r = 0; r < n; r++) {
      const runs: [number, number][] = [];
      let c = 0;
      while (c < n) {
        if (qr.isDark(r, c)) {
          const start = c;
          while (c < n && qr.isDark(r, c)) c++;
          runs.push([start, c - start]);
        } else {
          c++;
        }
      }
      all.push(runs);
    }
    return { n: out.n, all };
  }, [value]);

  const quiet = 4; // quiet zone in modules
  const cell = Math.floor(size / (rows.n + quiet * 2));
  const full = cell * (rows.n + quiet * 2);

  return (
    <View style={{ width: full, height: full, backgroundColor: '#fff', padding: cell * quiet, borderRadius: 8 }}>
      {rows.all.map((runs, r) => (
        <View key={r} style={{ height: cell, width: cell * rows.n }}>
          {runs.map(([start, len]) => (
            <View
              key={start}
              style={{ position: 'absolute', left: start * cell, width: len * cell, height: cell, backgroundColor: '#000' }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
