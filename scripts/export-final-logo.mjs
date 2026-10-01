import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Package the approved transparent bitmap without redrawing its geometry.
const brand = new URL('../public/brand/', import.meta.url);
const png = await readFile(new URL('zkdesk-logo-final.png', brand));
const data = `data:image/png;base64,${png.toString('base64')}`;
const image = (x, y, width, height) => `<image x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" href="${data}"/>`;
await writeFile(new URL('zkdesk-mark.svg', brand), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254" role="img" aria-label="ZKdesk logo">${image(0, 0, 1254, 1254)}</svg>`);
await writeFile(new URL('zkdesk-favicon.svg', brand), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="17" fill="#f2f2f4"/>${image(5, 5, 54, 54)}</svg>`);
await writeFile(new URL('zkdesk-banner.svg', brand), `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500"><rect width="1500" height="500" fill="#fdfdfd"/>${image(868, 57, 386, 386)}<text x="90" y="223" fill="#1d1e20" font-family="PP Neue Montreal,Helvetica,Arial,sans-serif" font-size="72" font-weight="350" letter-spacing="-3">ZKdesk</text><text x="94" y="275" fill="#72777d" font-family="PP Neue Montreal,Helvetica,Arial,sans-serif" font-size="24" font-weight="350">Your balance. Private.</text><path d="M94 322h37" stroke="#0071e3" stroke-width="2"/></svg>`);
console.log(`Final logo exports saved in ${fileURLToPath(brand)}`);
