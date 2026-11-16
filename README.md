# Letian Deng — 3D Card

An interactive, static viewer for Letian Deng's floating card island: a two-sided 3D business card you can turn over in the browser.

The front is a lunar card. The name and the lines under it are warm white, with a thin dark shadow so they stay readable on the grey ground. A burning sun, Jupiter and Saturn float in the space around the card. Earth, the Moon and Mars are set into the lunar ground. The portrait sits in a clear glass panel. The back is the forest face, with drifting clouds, butterflies, and fireflies around the contact details, which sit on a frosted plate. Drag orbits freely in either direction, scroll or pinch to zoom, and press the star or double-tap to turn to the other face by the shortest way. When the pointer is idle the card slowly turns; that motion is skipped when the system asks for reduced motion.

Live site (after GitHub Pages is enabled): <https://dengletian702-rgb.github.io/letian-card-3d/>

## Run locally

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173/letian-card-3d/>.

Production build:

```bash
npm run build
npm run preview
```

The preview is served at <http://127.0.0.1:4173/letian-card-3d/>. The headless check builds that same bundle and drives it in Chrome:

```bash
npm run test:e2e
```

Set `CHROME_PATH` if Chrome is not at `/opt/google/chrome/chrome`.

## Deploy

Pushes to `main` run `.github/workflows/pages.yml`, which builds the site and deploys the `dist/` folder with GitHub Actions. The app is built with base path `/letian-card-3d/`.

The repository owner needs to turn Pages on once:

1. Open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.

The next push to `main` (or a manual run of the "Deploy GitHub Pages" workflow) publishes <https://dengletian702-rgb.github.io/letian-card-3d/>.

## Lunar surface

The front of the card is a displaced mesh using a crop of the [NASA Scientific Visualization Studio CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) (SVS 4720). The colour is LROC WAC imagery (`lroc_color_poles_4k.tif`) and the height is LOLA/LDEM elevation (`ldem_4_uint.tif`), both public domain. The crop is desaturated to warm charcoal grey. Crater rims and slopes come from that elevation, with a soft detail normal on top. The lettering and the portrait sit on flat plateaus so the relief does not cut through them. The sun floats clear of the surface and lights the regolith.

Planet colour maps for Earth, the Moon, Mars, Jupiter and Saturn, and the Saturn ring, are the 2K textures published by [Solar System Scope](https://www.solarsystemscope.com/textures/) and used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The Moon map in that set is derived from NASA Lunar Reconnaissance Orbiter imagery.

## Model

The island was made in Blender and exported to glTF. In the viewer the origin is the centre of the card: the front (name and photo) faces +Z, and the back (forest, contacts, WhatsApp QR) faces −Z. Flipping rotates the card 180° about Y, the same axis as a horizontal drag.

`public/card-island.glb` is that export after web compression. Geometry uses [meshopt](https://github.com/zeux/meshopt) and repeated trees are GPU instances. Baked textures and the portrait are WebP. The QR stays a lossless PNG and is sampled with nearest-neighbour filtering so it can be scanned from the screen. The portrait and the QR are unlit, so the lights do not tint them. The type is warm white (`#F4F2EC`) and is not emissive, so the bloom pass does not glow the letters. Bloom is reserved for the sun and the small lights on the forest face.

`og.jpg` is a straight-on render of the front face. It is the social preview image and the image shown while the model loads.

## Credits

- 3D model: Letian Deng, made in Blender
- Viewer: [three.js](https://threejs.org/) (GLTFLoader, OrbitControls, meshopt decoder, a light bloom pass)

## License

[MIT](LICENSE)
