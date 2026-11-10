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
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
  },
});
