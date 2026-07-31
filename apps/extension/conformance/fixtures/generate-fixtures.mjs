import {
  createCanvas,
  loadImage,
} from 'canvas';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const outputDirectory = resolve(import.meta.dirname, 'inputs/v1');
mkdirSync(outputDirectory, { recursive: true });

const translated1 = await loadImage(resolve(repositoryRoot, 'docs/translated1.png'));
const translated4 = await loadImage(resolve(repositoryRoot, 'docs/translated4.png'));

function writePng(name, width, height, draw) {
  const canvas = createCanvas(width, height);
  draw(canvas.getContext('2d'));
  writeFileSync(resolve(outputDirectory, name), canvas.toBuffer('image/png'));
}

function writeJpeg(name, width, height, draw) {
  const canvas = createCanvas(width, height);
  draw(canvas.getContext('2d'));
  writeFileSync(
    resolve(outputDirectory, name),
    canvas.toBuffer('image/jpeg', { quality: 0.92, progressive: false }),
  );
}

writePng('translate-vertical-sparse.png', 420, 360, (context) => {
  context.drawImage(translated1, 80, 0, 420, 360, 0, 0, 420, 360);
});

writeJpeg('translate-horizontal.jpg', 640, 420, (context) => {
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 640, 420);
  context.drawImage(translated4, 0, 360, 1020, 670, 0, 0, 640, 420);
});

writePng('translate-mixed-dense.png', 900, 900, (context) => {
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 900, 900);
  context.drawImage(translated1, 0, 0, 743, 1024, 0, 0, 450, 620);
  context.drawImage(translated4, 180, 100, 840, 1050, 450, 280, 450, 620);
});

writePng('translate-irregular-quad.png', 720, 560, (context) => {
  context.fillStyle = '#f7f2e8';
  context.fillRect(0, 0, 720, 560);
  context.save();
  context.translate(360, 280);
  context.rotate(-8 * Math.PI / 180);
  context.transform(1, 0.08, -0.12, 1, 0, 0);
  context.drawImage(translated1, 80, 0, 650, 500, -325, -250, 650, 500);
  context.restore();
});

writePng('translate-font-punctuation-latin.png', 960, 540, (context) => {
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 960, 540);
  context.fillStyle = '#111';
  context.font = '700 54px Arial, sans-serif';
  context.fillText('ABC xyz 0123456789', 70, 130);
  context.font = '700 48px Arial, sans-serif';
  context.fillText('!?.,:; () [] {} /\\ +-=_%', 70, 225);
  context.font = '700 46px Arial, sans-serif';
  context.fillText('MIXED Case — ... “quotes”', 70, 320);
  context.font = '700 42px Arial, sans-serif';
  context.fillText('Vertical 90° / tate-chu-yoko 12', 70, 410);
});

writePng('translate-long-high-resolution.png', 1200, 3600, (context) => {
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 1200, 3600);
  for (let row = 0; row < 6; row += 1) {
    const source = row % 2 === 0 ? translated1 : translated4;
    context.drawImage(
      source,
      0,
      0,
      source.width,
      source.height,
      50,
      row * 600,
      1100,
      600,
    );
  }
});

writePng('erase-complete.png', 720, 720, (context) => {
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 720, 720);
  context.drawImage(translated4, 80, 100, 860, 1000, 0, 0, 720, 720);
});

writeJpeg('no-text-opaque.jpg', 640, 480, (context) => {
  const gradient = context.createLinearGradient(0, 0, 640, 480);
  gradient.addColorStop(0, '#b8d8ee');
  gradient.addColorStop(1, '#f7d9c4');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 640, 480);
  context.fillStyle = '#6ca36c';
  context.beginPath();
  context.arc(170, 220, 95, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#d69c5c';
  context.fillRect(360, 140, 170, 190);
});

writePng('no-text-transparent.png', 640, 480, (context) => {
  context.clearRect(0, 0, 640, 480);
  context.fillStyle = 'rgba(73, 126, 180, 0.5)';
  context.beginPath();
  context.arc(205, 240, 130, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = 'rgba(226, 142, 92, 0.72)';
  context.fillRect(340, 110, 190, 260);
});
