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
3. Capture with the app's own exporter (**Save view → Still image**, or
   **Cross-section** for the ψ tile) so the caption ribbon and
   attribution come with it. Tiles are 16:10 with `object-fit: cover`:
   pad the capture top/bottom with the export background `#0a1a18` to
   exactly 16:10 (don't crop — the caption sits at the left edge), then
   resize to 1600×1000. The November 2026 set was made this way.
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

## The Orbit tile is a GIF

Tile 1 looks for `earth-orbit.gif` (not `.jpg`) because the whole point
of the Orbit view is the seasonal motion — a static frame misses it.
Capture route: open `globe.html#v=o&f=sst`, then **Export image / GIF
→ GIF · annual cycle**. The exporter steps through all 12 months and
captures a frame each, giving you a one-year loop. Target ~2–5 MB so
the landing page stays fast; bump down the capture width in
`gif_export.js` `CAPTURE_MAX_WIDTH` or drop a second of duration if
you need it smaller.

Recommended export: ~150-250 KB each (nine tiles → ~2 MB total page
weight). The JPGs are lazy-loaded so below-the-fold tiles don't block
first paint.
