// Genera los íconos de las apps a partir de build/icono.svg, el carrete del logo de la interfaz.
// Correr con: npx electron scripts/iconos.cjs
//   - build/icon.png (512 px): electron-builder lo convierte en el ícono del .exe y del instalador.
//   - android/app/src/main/res/mipmap-*/: ícono clásico, redondo y la capa de adelante del ícono adaptable.
// Los PNG quedan commiteados: solo hace falta volver a correrlo si cambia el logo.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const BACKGROUND = '#100d1a';
const svg = fs.readFileSync(path.join(root, 'build', 'icono.svg'), 'utf8');
// Solo el carrete, sin fondo: el fondo lo pone cada variante.
const reel = svg.slice(svg.indexOf('<defs>'), svg.lastIndexOf('</svg>'));

/**
 * shape: 'square' (esquinas redondeadas), 'circle' o 'none' (transparente, para el ícono adaptable).
 * scale: qué parte del lado ocupa el carrete. El carrete no está centrado en su viewBox (la cola sale abajo a la
 * derecha), así que se centra por su caja: x 2..62, y 2..57.
 */
function iconSvg({ shape, scale }) {
  const box = { x: 2, y: 2, w: 60, h: 57 };
  const side = 64 * scale;
  const factor = side / Math.max(box.w, box.h);
  const tx = 32 - (box.x + box.w / 2) * factor;
  const ty = 32 - (box.y + box.h / 2) * factor;
  const bg =
    shape === 'square'
      ? `<rect width="64" height="64" rx="14" fill="${BACKGROUND}"/>`
      : shape === 'circle'
        ? `<circle cx="32" cy="32" r="32" fill="${BACKGROUND}"/>`
        : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${bg}<g transform="translate(${tx} ${ty}) scale(${factor})">${reel}</g></svg>`;
}

const outputs = [{ file: 'build/icon.png', size: 512, shape: 'square', scale: 0.78 }];
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, k] of Object.entries(densities)) {
  const dir = `android/app/src/main/res/mipmap-${name}`;
  outputs.push({ file: `${dir}/ic_launcher.png`, size: 48 * k, shape: 'square', scale: 0.78 });
  outputs.push({ file: `${dir}/ic_launcher_round.png`, size: 48 * k, shape: 'circle', scale: 0.7 });
  // Ícono adaptable: 108 dp, y Android puede recortar todo fuera del círculo central de 66 dp.
  outputs.push({ file: `${dir}/ic_launcher_foreground.png`, size: 108 * k, shape: 'none', scale: 0.56 });
}

async function render(win, markup, size) {
  const url = 'data:image/svg+xml;base64,' + Buffer.from(markup).toString('base64');
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(url)}; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = ${size};
    c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL('image/png');
  })()`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<meta charset=utf-8>');
  for (const output of outputs) {
    fs.writeFileSync(path.join(root, output.file), await render(win, iconSvg(output), Math.round(output.size)));
    console.log(output.file, Math.round(output.size) + ' px');
  }
  const background = path.join(root, 'android/app/src/main/res/values/ic_launcher_background.xml');
  fs.writeFileSync(background, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BACKGROUND}</color>\n</resources>\n`);
  app.quit();
});
