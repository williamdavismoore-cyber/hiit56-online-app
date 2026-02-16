#!/usr/bin/env node
/**
 * HIIT56 Vimeo Domain Allow-list Verification (CP26)
 *
 * Why:
 * Vimeo embed privacy settings can mimic "code bugs" if the current domain is not allow-listed.
 *
 * What this does:
 * - Loads all video_ids from site/assets/data/videos_all.json
 * - For videos that use privacy.embed = "whitelist", it checks the domain allow-list.
 * - Optionally auto-fixes by adding missing domains (requires token scopes that allow editing).
 *
 * Usage:
 *   VIMEO_TOKEN="..." node tools/vimeo_allowlist_check.mjs --domain localhost --domain 127.0.0.1
 *   VIMEO_TOKEN="..." node tools/vimeo_allowlist_check.mjs --domain yourdomain.com --fix
 *
 * Notes:
 * - If a video is NOT whitelist-embedded, we treat it as "not applicable".
 * - If your Netlify preview uses multiple ephemeral domains, pass the exact domain you need.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const API = 'https://api.vimeo.com';

function argList(flag){
  const out = [];
  const argv = process.argv.slice(2);
  for(let i=0;i<argv.length;i++){
    if(argv[i] === flag && argv[i+1]){
      out.push(argv[i+1]);
      i++;
    }
  }
  return out;
}
function hasFlag(flag){
  return process.argv.slice(2).includes(flag);
}

const domains = argList('--domain');
const doFix = hasFlag('--fix');
const limitRaw = argList('--limit')[0];
const limit = limitRaw ? Number(limitRaw) : null;

const token = process.env.VIMEO_TOKEN || process.env.VIMEO_ACCESS_TOKEN || '';
if(!token){
  console.error('Missing VIMEO_TOKEN env var.');
  process.exit(2);
}
if(domains.length === 0){
  console.error('Provide at least one --domain to verify (e.g. --domain localhost).');
  process.exit(2);
}

const kitRoot = process.cwd();
const videosPath = path.join(kitRoot, 'site', 'assets', 'data', 'videos_all.json');
if(!fs.existsSync(videosPath)){
  console.error('Cannot find videos_all.json at:', videosPath);
  process.exit(2);
}

const videos = JSON.parse(fs.readFileSync(videosPath, 'utf8'));
const ids = Array.from(new Set((videos||[]).map(v => Number(v.video_id)).filter(Boolean)));
const idsToCheck = limit ? ids.slice(0, limit) : ids;

async function vimeoFetch(url, opts={}){
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `bearer ${token}`,
      'Accept': 'application/vnd.vimeo.*+json;version=3.4',
      ...(opts.headers || {})
    }
  });
  const txt = await res.text();
  let data = null;
  try{ data = txt ? JSON.parse(txt) : null; }catch(e){}
  if(!res.ok){
    const msg = (data && (data.error || data.message)) ? (data.error || data.message) : txt;
    throw new Error(`${res.status} ${res.statusText} — ${msg}`);
  }
  return data;
}

async function getEmbedPrivacy(id){
  const url = `${API}/videos/${id}?fields=privacy.embed`;
  const data = await vimeoFetch(url);
  return data?.privacy?.embed || null;
}

async function listWhitelistDomains(id){
  const out = [];
  let page = 1;
  while(true){
    const url = `${API}/videos/${id}/privacy/domains?per_page=100&page=${page}`;
    const data = await vimeoFetch(url);
    const rows = data?.data || [];
    for(const r of rows){
      if(r && r.domain) out.push(String(r.domain).toLowerCase());
    }
    const total = Number(data?.total || rows.length);
    const per = Number(data?.per_page || 100);
    const pages = Math.ceil(total / per);
    if(page >= pages) break;
    page++;
  }
  return Array.from(new Set(out));
}

async function addWhitelistDomain(id, domain){
  const d = String(domain).toLowerCase();
  const url = `${API}/videos/${id}/privacy/domains/${encodeURIComponent(d)}`;
  // Vimeo expects PUT with empty body
  await vimeoFetch(url, { method: 'PUT' });
}

let whitelistCount = 0;
let missingTotal = 0;
const missingByVideo = [];

console.log(`\nHIIT56 Vimeo allow-list check — ${idsToCheck.length} videos scanned`);
console.log(`Required domains: ${domains.join(', ')}`);
console.log(`Fix mode: ${doFix ? 'ON' : 'OFF'}\n`);

for(const id of idsToCheck){
  try{
    const embedPrivacy = await getEmbedPrivacy(id);
    if(embedPrivacy !== 'whitelist'){
      continue;
    }
    whitelistCount++;
    const allowed = await listWhitelistDomains(id);
    const missing = domains
      .map(d => String(d).toLowerCase())
      .filter(d => !allowed.includes(d));

    if(missing.length){
      missingTotal += missing.length;
      missingByVideo.push({ id, missing });
      console.log(`❌ Video ${id} missing: ${missing.join(', ')}`);

      if(doFix){
        for(const d of missing){
          try{
            await addWhitelistDomain(id, d);
            console.log(`   ✅ added ${d}`);
          }catch(e){
            console.log(`   ⚠️  failed to add ${d}: ${String(e && e.message ? e.message : e)}`);
          }
        }
      }
    }
  }catch(e){
    console.log(`⚠️  Video ${id} check failed: ${String(e && e.message ? e.message : e)}`);
  }
}

console.log(`\nWhitelist videos: ${whitelistCount}`);
if(missingByVideo.length){
  console.log(`Videos with missing domains: ${missingByVideo.length} (missing entries: ${missingTotal})`);
  process.exit(doFix ? 0 : 1);
} else {
  console.log('All checked whitelist videos include the required domains.');
  process.exit(0);
}
