# Gallery thumbnails

Nine deep-link tiles on the landing page look for screenshots here.
Until a file exists, each tile shows a CSS gradient placeholder with a
hint label — the page still looks intentional. Drop a JPG in and the
tile upgrades automatically.

## Workflow

1. Open the tile's target URL in Chrome (click the tile, or copy the
   href from `index.html`).
2. Let the data load. Optional: adjust the view a little (camera angle,
   month-within-season) if you want a more flattering framing.
3. Capture the globe/map area — **macOS:** Cmd-Shift-4, then drag over
   the canvas. Target ~1000-1600 px wide, 10:6.3 aspect.
4. Save as `<slug>.jpg` at ~80% quality into this directory. Slugs:

   | Slug                   | View                        |
   |------------------------|-----------------------------|
   | earth-orbit            | Earth in its orbit          |
   | winter-jets            | The winter jets             |
   | stationary-waves       | Stationary waves            |
   | monsoon-jja            | The summer monsoon          |
   | walker-chi             | The Walker circulation      |
   | warming-1961           | Warming since 1961          |
   | elnino-roni            | El Niño in January          |
   | pv-330k                | The dynamic tropopause      |
   | hadley-djf             | The Hadley cells            |

5. Hard-reload the landing page. Tile now shows the real screenshot.

Recommended export: ~150-250 KB each (nine tiles → ~2 MB total page
weight). The JPGs are lazy-loaded so below-the-fold tiles don't block
first paint.
