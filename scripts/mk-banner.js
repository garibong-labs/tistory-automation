#!/usr/bin/env node
/**
 * mk-banner.js — 매경 1면 이미지 다운로드 + 1150x630 배너 크롭
 * 
 * Usage:
 *   node mk-banner.js              # 오늘 날짜 (주말이면 최근 평일 이미지 사용, 파일명도 평일 날짜)
 *   node mk-banner.js 2026-02-21   # 특정 날짜 (강제)
 *   node mk-banner.js --clipboard  # 클립보드까지 복사
 * 
 * Output:
 *   /tmp/mk-banner-YYYY-MM-DD.jpg  (1150x630, 파일명 = 실제 사용 이미지 날짜)
 *   stdout에 출력 파일 경로 출력
 * 
 * Dependencies:
 *   sharp (OpenClaw 내장)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch {
  try {
    sharp = require('/opt/homebrew/lib/node_modules/openclaw/node_modules/sharp');
  } catch (e) {
    console.error('❌ sharp 모듈을 찾을 수 없습니다. npm install sharp 실행 필요.');
    process.exit(1);
  }
}

const BANNER_WIDTH = 1150;
const BANNER_HEIGHT = 630;
const MK_URL_PATTERN = 'https://file2.mk.co.kr/mkde/{YYYY}/{MM}/{DD}/page/01_01_ORG.jpg';
const OUTPUT_DIR = '/tmp';
const DEFAULT_BORDER = { enabled: true, size: 2, color: '#D0D0D0' };

function getDateStr(dateArg) {
  let d;
  if (dateArg instanceof Date) {
    d = dateArg;
  } else if (typeof dateArg === 'string' && dateArg) {
    d = new Date(dateArg + 'T00:00:00+09:00');
  } else {
    d = new Date();
  }
  const yyyy = d.getFullYear().toString();
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return { yyyy, mm, dd };
}

// 주말 fallback 순서: 일→[토,금], 토→[토,금], 평일→[당일]
function getFallbackDates(requestedDate) {
  const day = requestedDate.getDay();
  const dates = [];
  if (day === 0) {
    dates.push(new Date(requestedDate.getFullYear(), requestedDate.getMonth(), requestedDate.getDate() - 1));
    dates.push(new Date(requestedDate.getFullYear(), requestedDate.getMonth(), requestedDate.getDate() - 2));
  } else if (day === 6) {
    dates.push(new Date(requestedDate));
    dates.push(new Date(requestedDate.getFullYear(), requestedDate.getMonth(), requestedDate.getDate() - 1));
  } else {
    dates.push(new Date(requestedDate));
  }
  return dates;
}

function buildUrl(yyyy, mm, dd) {
  return MK_URL_PATTERN.replace('{YYYY}', yyyy).replace('{MM}', mm).replace('{DD}', dd);
}

function download(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function cropBanner(inputBuffer, width, height, border = DEFAULT_BORDER) {
  const meta = await sharp(inputBuffer).metadata();
  const targetRatio = width / height;
  const srcRatio = meta.width / meta.height;

  let cropWidth, cropHeight, left, top;
  if (srcRatio > targetRatio) {
    // 원본이 더 넓음 → 좌우 크롭, 높이 유지
    cropHeight = meta.height;
    cropWidth = Math.round(meta.height * targetRatio);
    left = Math.round((meta.width - cropWidth) / 2);
    top = 0;
  } else {
    // 원본이 더 높음 → 상하 크롭, 너비 유지
    cropWidth = meta.width;
    cropHeight = Math.min(meta.height, Math.round(meta.width / targetRatio));
    left = 0;
    top = 0;
  }

  let pipeline = sharp(inputBuffer).extract({ left, top, width: cropWidth, height: cropHeight }).resize(width, height);
  if (border?.enabled) {
    const b = Math.max(1, border.size || 2);
    const svg = Buffer.from(
      `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${b/2}" y="${b/2}" width="${width - b}" height="${height - b}" fill="none" stroke="${border.color || '#D0D0D0'}" stroke-width="${b}"/>
      </svg>`
    );
    pipeline = pipeline.composite([{ input: svg, top: 0, left: 0 }]);
  }
  return pipeline.jpeg({ quality: 90 }).toBuffer();
}

function copyToClipboard(filePath) {
  const { execSync } = require('child_process');
  const absPath = path.resolve(filePath);
  const script = `set the clipboard to (read (POSIX file "${absPath}") as JPEG picture)`;
  execSync(`osascript -e '${script}'`);
}

let banner;
async function downloadAndSave(targetDate) {
  const { yyyy, mm, dd } = getDateStr(targetDate);
  const url = buildUrl(yyyy, mm, dd);
  console.error(`📥 다운로드 시도: ${url}`);
  try {
    const buf = await download(url);
    const bordered = await cropBanner(buf, BANNER_WIDTH, BANNER_HEIGHT, DEFAULT_BORDER);
    // 파일명도 실제 사용 이미지 날짜(targetDate) 기준
    const op = path.join(OUTPUT_DIR, `mk-banner-${yyyy}-${mm}-${dd}.jpg`);
    fs.writeFileSync(op, bordered);
    console.error(`✅ 저장: ${op} (${(bordered.length / 1024).toFixed(1)}KB)`);
    banner = op;
    return op;
  } catch (e) {
    console.error(`❌ 다운로드 실패 (${url}): ${e.message}`);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const clipboard = args.includes('--clipboard') || args.includes('-c');
  const dateArg = args.find(a => !a.startsWith('-'));

  const requestedDate = dateArg ? new Date(dateArg + 'T00:00:00+09:00') : new Date();
  const candidates = getFallbackDates(requestedDate);

  let savedPath = null;
  let usedDate = null;
  for (const cand of candidates) {
    savedPath = await downloadAndSave(cand);
    if (savedPath) {
      usedDate = cand;
      break;
    }
  }
  if (!savedPath) {
    console.error('❌ 모든 대체 날짜 시도 실패');
    process.exit(1);
  }

  const day = requestedDate.getDay();
  const dayLabel = day === 0 ? '일' : day === 6 ? '토' : '평일';
  if (requestedDate.getTime() !== usedDate.getTime()) {
    console.warn(`📌 주말 감지(${dayLabel}) → 평일 이미지로 대체 (${usedDate.getFullYear()}-${(usedDate.getMonth()+1).toString().padStart(2,'0')}-${usedDate.getDate().toString().padStart(2,'0')})`);
  }

  if (clipboard) {
    try { copyToClipboard(banner); console.error('📋 클립보드 복사 완료'); }
    catch (e) { console.error(`⚠️ 클립보드 복사 실패: ${e.message}`); }
  }
  console.log(banner);
}

main().catch(e => { console.error(`❌ 에러: ${e.message}`); process.exit(1); });
