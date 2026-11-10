// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
// Based on Vibe-Time-Billing apps/portal/vite.config.ts @ 4b14d2f5 (no PWA in v1).
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

import { fontScaleBootstrapScript } from '../../packages/ui/src/tokens';

function fontScaleBootstrap(): Plugin {
  return {
    name: 'vibe-font-scale-bootstrap',
    transformIndexHtml(html: string): string {
      return html.replace(
        /[ \t]*<!-- FONT_SCALE_BOOTSTRAP[^>]*-->/,
        `    <script>${fontScaleBootstrapScript}</script>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), fontScaleBootstrap()],
  server: {
    port: 5197,
    proxy: {
      '/api': 'http://localhost:3101',
      '/health': 'http://localhost:3101',
    },
  },
  build: {
    outDir: 'dist',
    // The image is public and the source private (P40): no source maps (QA 2026-11-09).
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    // A desktop-sized screen unless a test says otherwise (jsdom reports a width of 0).
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
