# Letian Deng — 3D Card

An interactive, static viewer for Letian Deng's floating card island: a two-sided 3D business card you can turn over in the browser.

The front is a lunar card with gilded lettering, a small sun, and a ringed planet. The back is the forest face, with drifting clouds, butterflies, and fireflies around the contact details. Drag orbits freely in either direction, scroll or pinch to zoom, and press the star or double-tap to turn to the other face by the shortest way. When the pointer is idle the card slowly turns; that motion is skipped when the system asks for reduced motion.

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

## Model

The island was made in Blender and exported to glTF. In the viewer the origin is the centre of the card: the front (name and photo) faces +Z, and the back (forest, contacts, WhatsApp QR) faces −Z. Flipping rotates the card 180° about Y, the same axis as a horizontal drag.

`public/card-island.glb` is that export after web compression. Geometry uses [meshopt](https://github.com/zeux/meshopt) and repeated trees are GPU instances. Baked textures and the portrait are WebP. The QR stays a lossless PNG and is sampled with nearest-neighbour filtering so it can be scanned from the screen. The portrait and the QR are unlit, so the lights do not tint them. Emissive plants and lettering go through a light bloom pass.

`og.jpg` is a straight-on render of the front face. It is the social preview image and the image shown while the model loads.

## Credits

- 3D model: Letian Deng, made in Blender
- Viewer: [three.js](https://threejs.org/) (GLTFLoader, OrbitControls, meshopt decoder, a light bloom pass)

## License

[MIT](LICENSE)
