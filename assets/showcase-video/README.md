# Dispatcher Showcase Video

A [Remotion](https://www.remotion.dev/) product showcase video for Dispatcher. The rendered video is checked in as [`dispatcher-showcase.mp4`](./dispatcher-showcase.mp4). It walks through the core features in ~44 seconds at 1920×1080 / 30fps:

1. **Intro** — logo and tagline
2. **Projects** — project tree sidebar; per-tab notes type out in the detail panel, then collapse away
3. **Split panes** — animated horizontal + vertical splits
4. **Focus** — a background tab finishes and gets the green attention outline
5. **Remote** — SSH sessions appear as regular tabs and survive restarts
6. **Outro** — platforms and repo link

The mock app chrome (`src/components/AppWindow.tsx`) and color palette (`src/theme.ts`) mirror the real app's `src/App.css` so the video matches the product.

## Usage

```bash
cd assets/showcase-video
npm install

# Live preview in Remotion Studio
npm start

# Render the MP4
npm run render
# → out/dispatcher-showcase.mp4

# Render a poster frame
npm run still
```

## Editing

- Scene order and durations live in `src/Showcase.tsx` (`SCENES`).
- Each scene is a standalone component in `src/scenes/`.
- Terminal content is declarative — see the `TermLine` type in `src/components/Terminal.tsx` for typing/delay options.
