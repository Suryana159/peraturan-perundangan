/**
 * scan-peraturan.js
 * ------------------------------------------------------------
 * Dijalankan otomatis oleh GitHub Actions (lihat .github/workflows/scan-peraturan.yml)
 * setiap hari. Tugasnya:
 *   1. Membaca daftar feed RSS Google Alerts dari rss-feeds.json
 *   2. Mengambil & mem-parsing setiap feed
 *   3. Membersihkan link (Google Alerts membungkus link asli)
 *   4. Menyimpan entri BARU ke Firebase Realtime Database (REST API)
 *   5. Mengirim notifikasi WhatsApp (CallMeBot) untuk entri baru
 *
 * Tidak ada dependency npm eksternal — hanya modul bawaan Node.js.
 * ------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIREBASE_URL = process.env.FIREBASE_URL; // contoh: https://xxxx-default-rtdb.asia-southeast1.firebasedatabase.app
const FIREBASE_AUTH = process.env.FIREBASE_AUTH || ''; // opsional, database secret / ID token
const CALLMEBOT_PHONE = process.env.CALLMEBOT_PHONE || '';
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY || '';

if (!FIREBASE_URL) {
  console.error('❌ FIREBASE_URL belum diset di GitHub Secrets. Berhenti.');
  process.exit(1);
}

function authSuffix(extra) {
  const parts = [];
  if (FIREBASE_AUTH) parts.push(`auth=${encodeURIComponent(FIREBASE_AUTH)}`);
  if (extra) parts.push(extra);
  return parts.length ? `?${parts.join('&')}` : '';
}

function loadFeeds() {
  const file = path.join(__dirname, 'rss-feeds.json');
  if (!fs.existsSync(file)) {
    console.error('❌ rss-feeds.json tidak ditemukan.');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw.filter(f => f.url && !f.url.includes('GANTI_DENGAN'));
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  return m[1]
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .trim();
}

function stripHtml(str) {
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function cleanGoogleLink(rawLink) {
  const link = stripHtml(rawLink);
  try {
    const u = new URL(link);
    if (u.hostname.includes('google.') && u.searchParams.has('url')) {
      return u.searchParams.get('url');
    }
    return link;
  } catch {
    return link;
  }
}

function extractLinkHref(block) {
  // Atom style: <link rel="alternate" href="..."/>  (self-closing, attributes in any order)
  const m = block.match(/<link\b[^>]*href="([^"]+)"[^>]*\/?>/i);
  if (m) return m[1];
  // RSS style: <link>https://...</link>
  return extractTag(block, 'link');
}

function parseRSS(xml) {
  const items = [];
  const isAtom = /<entry[\s>]/i.test(xml);
  const tag = isAtom ? 'entry' : 'item';
  const blocks = xml.split(new RegExp(`<${tag}[\\s>]`, 'i')).slice(1);

  for (let raw of blocks) {
    const block = raw.split(new RegExp(`<\\/${tag}>`, 'i'))[0];
    const title = stripHtml(extractTag(block, 'title'));
    const link = cleanGoogleLink(extractLinkHref(block));
    const dateRaw = isAtom
      ? (extractTag(block, 'published') || extractTag(block, 'updated') || extractTag(block, 'issued'))
      : extractTag(block, 'pubDate');
    const pubDate = dateRaw ? new Date(dateRaw) : new Date();
    if (title && link) {
      items.push({ title, link, pubDate: (isNaN(pubDate) ? new Date() : pubDate).toISOString() });
    }
  }
  return items;
}

function makeKey(link) {
  return crypto.createHash('md5').update(link).digest('hex').slice(0, 16);
}

async function fetchExistingKeys() {
  const res = await fetch(`${FIREBASE_URL}/peraturan.json${authSuffix('shallow=true')}`);
  if (!res.ok) {
    console.error('❌ Gagal membaca Firebase:', res.status, await res.text());
    return new Set();
  }
  const data = await res.json();
  return new Set(data ? Object.keys(data) : []);
}

async function saveItem(key, item) {
  const res = await fetch(`${FIREBASE_URL}/peraturan/${key}.json${authSuffix()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  return res.ok;
}

async function sendWhatsAppNotif(newItems) {
  if (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY) {
    console.log('ℹ️  CallMeBot belum dikonfigurasi, lewati notifikasi WA.');
    return;
  }
  if (newItems.length === 0) return;

  const maxListed = 5;
  const lines = newItems.slice(0, maxListed).map((it, i) => `${i + 1}. [${it.kategori}] ${it.judul}`);
  if (newItems.length > maxListed) lines.push(`...dan ${newItems.length - maxListed} lainnya`);

  const text =
    `📋 PERATURAN BARU (${newItems.length})\n` +
    `Terkait industri semen, ditemukan otomatis:\n\n` +
    lines.join('\n') +
    `\n\nBuka aplikasi untuk detail & link lengkap.`;

  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(
    CALLMEBOT_PHONE
  )}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(CALLMEBOT_APIKEY)}`;

  try {
    const res = await fetch(url);
    console.log('📲 Notifikasi WA terkirim, status:', res.status);
  } catch (e) {
    console.error('❌ Gagal kirim WA:', e.message);
  }
}

async function main() {
  const feeds = loadFeeds();
  if (feeds.length === 0) {
    console.log('⚠️  Tidak ada feed RSS yang terisi di rss-feeds.json. Isi dulu URL Google Alerts-nya.');
    return;
  }

  console.log(`🔍 Mengecek ${feeds.length} feed RSS...`);
  const existingKeys = await fetchExistingKeys();
  const newlyAdded = [];

  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url);
      if (!res.ok) {
        console.error(`❌ Gagal fetch feed "${feed.label}":`, res.status);
        continue;
      }
      const xml = await res.text();
      const items = parseRSS(xml);
      console.log(`   → "${feed.label}": ${items.length} item ditemukan di feed`);

      for (const item of items) {
        const key = makeKey(item.link);
        if (existingKeys.has(key)) continue; // sudah ada, lewati

        const record = {
          judul: item.title,
          link: item.link,
          kategori: feed.kategori || 'lainnya',
          sumber: feed.label,
          tanggalTerbit: item.pubDate,
          tanggalMasuk: new Date().toISOString(),
          status: 'baru',
          ditambahkanOleh: 'auto',
        };

        const ok = await saveItem(key, record);
        if (ok) {
          existingKeys.add(key);
          newlyAdded.push(record);
          console.log(`   ✅ Baru: ${item.title}`);
        }
      }
    } catch (e) {
      console.error(`❌ Error di feed "${feed.label}":`, e.message);
    }
  }

  console.log(`\n📊 Total entri baru: ${newlyAdded.length}`);
  await sendWhatsAppNotif(newlyAdded);
}

main().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
