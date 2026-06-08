// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://truffleagent.com',
  output: 'static',
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
  integrations: [
    sitemap({
      serialize(item) {
        const url = new URL(item.url);
        const path = url.pathname;
        if (path === '/' || path === '/spin/' || path === '/lens/') {
          item.priority = 1.0;
          item.changefreq = 'weekly';
        } else if (
          path === '/maintains/' ||
          path === '/glyph/' ||
          path === '/nook/' ||
          path === '/agentlang/'
        ) {
          item.priority = 0.8;
          item.changefreq = 'weekly';
        } else if (path.startsWith('/spin/') && path !== '/spin/') {
          item.priority = 0.7;
          item.changefreq = 'weekly';
        } else {
          item.priority = 0.5;
          item.changefreq = 'monthly';
        }
        return item;
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
  build: {
    inlineStylesheets: 'auto',
  },
  experimental: {},
});
